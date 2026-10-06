// Pure model -> graph data. No positions here (see layout.ts); shapes are plain
// objects compatible with React Flow's Node/Edge so this stays testable.
import type { GraphRun, Outcome } from "../api/types";
import { matchesFilters, type Filters } from "../state/filters";
import { chainLinks, type ChainLabel } from "./chain";
import { triggerLabel } from "./labels";

export { triggerLabel };

export type FlowNodeData =
  | { kind: "trigger"; trigger: GraphRun["trigger"]; label: string; at: string }
  | { kind: "run"; run: GraphRun; selected: boolean }
  | { kind: "outcome"; outcome: Outcome };

export interface FlowGraph {
  nodes: { id: string; type: FlowNodeData["kind"]; data: FlowNodeData }[];
  /** `label` marks a link between runs about the same pull request (see chain.ts). */
  edges: { id: string; source: string; target: string; animated: boolean; label?: ChainLabel }[];
}

const isLive = (r: GraphRun) => r.status === "pending" || r.status === "running";

const byStartedAsc = (a: GraphRun, b: GraphRun) =>
  a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const byStartedDesc = (a: GraphRun, b: GraphRun) =>
  a.startedAt > b.startedAt ? -1 : a.startedAt < b.startedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function buildGraph(runs: readonly GraphRun[], filters: Filters, selectedId: string | null): FlowGraph {
  const byId = new Map(runs.map((r) => [r.id, r]));

  // Keep every matching run plus all of its ancestors so trees stay connected.
  const keep = new Set<string>();
  for (const r of runs) {
    if (!matchesFilters(r, filters)) continue;
    let cur: GraphRun | undefined = r;
    while (cur && !keep.has(cur.id)) {
      keep.add(cur.id);
      cur = cur.parentRunId === null ? undefined : byId.get(cur.parentRunId);
    }
  }

  const kept = runs.filter((r) => keep.has(r.id));
  const children = new Map<string, GraphRun[]>();
  const roots: GraphRun[] = [];
  for (const r of kept) {
    if (r.parentRunId !== null && byId.has(r.parentRunId)) {
      const list = children.get(r.parentRunId) ?? [];
      list.push(r);
      children.set(r.parentRunId, list);
    } else {
      roots.push(r);
    }
  }
  roots.sort(byStartedDesc);

  const graph: FlowGraph = { nodes: [], edges: [] };
  const link = (source: string, target: string, animated: boolean) =>
    graph.edges.push({ id: `${source}->${target}`, source, target, animated });

  const emitRun = (r: GraphRun) => {
    graph.nodes.push({
      id: `r:${r.id}`,
      type: "run",
      data: { kind: "run", run: r, selected: r.id === selectedId },
    });
    r.outcomes.forEach((outcome, i) => {
      const id = `o:${r.id}:${i}`;
      graph.nodes.push({ id, type: "outcome", data: { kind: "outcome", outcome } });
      link(`r:${r.id}`, id, isLive(r));
    });
    for (const child of (children.get(r.id) ?? []).sort(byStartedAsc)) {
      emitRun(child);
      link(`r:${r.id}`, `r:${child.id}`, isLive(child));
    }
  };

  // Runs about the same pull request join one chain; a linked root's own trigger box is dropped.
  const chain = chainLinks(
    kept,
    roots.map((r) => r.id),
  );
  const linked = new Set(chain.map((l) => l.toRunId));

  for (const root of roots) {
    if (linked.has(root.id)) {
      emitRun(root);
      continue;
    }
    const tid = `t:${root.id}`;
    graph.nodes.push({
      id: tid,
      type: "trigger",
      data: { kind: "trigger", trigger: root.trigger, label: triggerLabel(root.trigger), at: root.startedAt },
    });
    link(tid, `r:${root.id}`, isLive(root));
    emitRun(root);
  }
  for (const l of chain) {
    const target = `r:${l.toRunId}`;
    graph.edges.push({
      id: `${l.from}~>${l.label}~>${target}`,
      source: l.from,
      target,
      animated: isLive(byId.get(l.toRunId)!),
      label: l.label,
    });
  }
  return graph;
}
