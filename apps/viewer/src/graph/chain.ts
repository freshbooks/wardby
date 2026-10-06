// The runs around one pull request, chained in time order: the run that opened
// it, then each review, @wardby mention and automatic fix round (a webhook run
// whose tree pushed to the PR). Pure: build.ts turns the links into edges.
import type { GraphRun } from "../api/types";

export type ChainLabel = "review" | "mention" | "fix";

export interface ChainLink {
  /** Node id the link starts from: an outcome box `o:<runId>:<i>`, or a run box `r:<runId>`. */
  from: string;
  /** The root run the link leads to (its own trigger box is dropped). */
  toRunId: string;
  label: ChainLabel;
}

type EntryKind = "pull_request" | "check" | "code_host_comment";

interface Entry {
  key: string;
  nodeId: string;
  runId: string;
  kind: EntryKind;
}

/** Within one run, the box that best stands for "where this step ended". */
const KIND_RANK: Record<EntryKind, number> = { check: 3, code_host_comment: 2, pull_request: 1 };

export function prKey(provider: string, repository: string, number: number | null): string | null {
  return number === null ? null : `${provider}:${repository.toLowerCase()}#${number}`;
}

const byStart = (a: GraphRun, b: GraphRun) =>
  a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** The PR-related outcome boxes of every run, by PR key. */
function prEntries(runs: readonly GraphRun[]): Entry[] {
  const out: Entry[] = [];
  for (const r of runs) {
    r.outcomes.forEach((o, i) => {
      if (o.kind !== "pull_request" && o.kind !== "check" && o.kind !== "code_host_comment") return;
      const key = prKey(o.provider, o.repository, o.number);
      if (key) out.push({ key, nodeId: `o:${r.id}:${i}`, runId: r.id, kind: o.kind });
    });
  }
  return out;
}

/** Root id of each run (following parentRunId within `runs`). */
function rootsOf(runs: readonly GraphRun[]): Map<string, string> {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const rootOf = new Map<string, string>();
  const find = (r: GraphRun): string => {
    const known = rootOf.get(r.id);
    if (known) return known;
    const parent = r.parentRunId === null ? undefined : byId.get(r.parentRunId);
    const root = parent ? find(parent) : r.id;
    rootOf.set(r.id, root);
    return root;
  };
  for (const r of runs) find(r);
  return rootOf;
}

/** `runs`: the runs being drawn; `roots`: their root run ids (no drawn parent). */
export function chainLinks(runs: readonly GraphRun[], roots: readonly string[]): ChainLink[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const rootOf = rootsOf(runs);
  const entries = prEntries(runs);
  const startOf = (runId: string) => byId.get(runId)!.startedAt;

  // Anchor per key: the pull_request box of the earliest-started run that has one.
  const anchors = new Map<string, Entry>();
  for (const e of entries) {
    if (e.kind !== "pull_request") continue;
    const cur = anchors.get(e.key);
    if (!cur || byStart(byId.get(e.runId)!, byId.get(cur.runId)!) < 0) anchors.set(e.key, e);
  }

  // A root's boxes for each PR key, indexed once (the graph is rebuilt on every click).
  const byKeyRoot = new Map<string, Map<string, Entry[]>>();
  for (const e of entries) {
    const root = rootOf.get(e.runId)!;
    const perRoot = byKeyRoot.get(e.key) ?? new Map<string, Entry[]>();
    perRoot.set(root, [...(perRoot.get(root) ?? []), e]);
    byKeyRoot.set(e.key, perRoot);
  }

  // Candidate roots per key, claimed by the key whose anchor is earliest. A root that
  // started before a key's anchor can't follow it, so it stays free for another key.
  const candidates = new Map<string, { root: GraphRun; label: ChainLabel }[]>();
  const claimed = new Set<string>();
  const keysByAnchorAge = [...anchors.keys()].sort((a, b) =>
    byStart(byId.get(anchors.get(a)!.runId)!, byId.get(anchors.get(b)!.runId)!),
  );
  for (const key of keysByAnchorAge) {
    const anchorRoot = rootOf.get(anchors.get(key)!.runId);
    const anchorStart = startOf(anchors.get(key)!.runId);
    const perRoot = byKeyRoot.get(key)!;
    const list: { root: GraphRun; label: ChainLabel }[] = [];
    for (const id of roots) {
      const root = byId.get(id);
      if (!root || id === anchorRoot || claimed.has(id) || root.startedAt < anchorStart) continue;
      const t = root.trigger;
      let label: ChainLabel | null = null;
      if (t.kind === "code_host" && prKey(t.provider, t.repository, t.number) === key) label = t.event;
      else if (t.kind === "webhook" && perRoot.get(id)?.some((e) => e.kind === "pull_request")) label = "fix";
      if (label) {
        list.push({ root, label });
        claimed.add(id);
      }
    }
    candidates.set(
      key,
      list.sort((a, b) => byStart(a.root, b.root)),
    );
  }

  // Each root has at most one incoming link; a link that would lead back to its own
  // source (possible only when trees start at the same instant) is skipped.
  const incoming = new Map<string, string>();
  const reachesBack = (fromRoot: string, toRoot: string) => {
    for (let cur: string | undefined = fromRoot; cur; cur = incoming.get(cur)) if (cur === toRoot) return true;
    return false;
  };

  const links: ChainLink[] = [];
  for (const key of keysByAnchorAge) {
    const anchor = anchors.get(key)!;
    const perRoot = byKeyRoot.get(key)!;
    let prev = anchor.nodeId;
    let prevRoot = rootOf.get(anchor.runId)!;
    for (const { root, label } of candidates.get(key) ?? []) {
      if (reachesBack(prevRoot, root.id)) continue;
      links.push({ from: prev, toRunId: root.id, label });
      incoming.set(root.id, prevRoot);
      // The step ends at its tree's latest box for this PR (by run start, then box kind).
      const last = [...(perRoot.get(root.id) ?? [])]
        .sort((a, b) => byStart(byId.get(a.runId)!, byId.get(b.runId)!) || KIND_RANK[a.kind] - KIND_RANK[b.kind])
        .at(-1);
      prev = last ? last.nodeId : `r:${root.id}`;
      prevRoot = root.id;
    }
  }
  return links;
}
