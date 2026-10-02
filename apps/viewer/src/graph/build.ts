// Pure model -> graph data. No positions here (see layout.ts); shapes are plain
// objects compatible with React Flow's Node/Edge so this stays testable.
import type { GraphRun, Outcome, RunStatus } from "../api/types";

export interface Filters {
  statuses: ReadonlySet<RunStatus> | null;
  agentIds: ReadonlySet<string> | null;
  search: string;
}

export type FlowNodeData =
  | { kind: "trigger"; trigger: GraphRun["trigger"]; label: string }
  | { kind: "run"; run: GraphRun; selected: boolean }
  | { kind: "outcome"; outcome: Outcome };

export interface FlowGraph {
  nodes: { id: string; type: FlowNodeData["kind"]; data: FlowNodeData }[];
  edges: { id: string; source: string; target: string; animated: boolean }[];
}

export function triggerLabel(trigger: GraphRun["trigger"]): string {
  switch (trigger.kind) {
    case "scheduled":
      return `⏰ ${trigger.schedule ?? "scheduled"}`;
    case "webhook":
      return "webhook";
    case "manual":
      return "manual";
    case "issue":
      return `◆ ${trigger.provider} ${trigger.issueKey}`;
    case "code_host":
      return `⎇ ${trigger.repository}${trigger.number === null ? "" : `#${trigger.number}`} ${trigger.event}`;
    case "host_event":
      return "host event";
    case "subagent":
      return "sub-agent";
  }
}

function outcomeTerms(o: Outcome): string[] {
  return "repository" in o ? [o.repository] : [o.issueKey];
}

const isLive = (r: GraphRun) => r.status === "pending" || r.status === "running";

const byStartedAsc = (a: GraphRun, b: GraphRun) =>
  a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const byStartedDesc = (a: GraphRun, b: GraphRun) =>
  a.startedAt > b.startedAt ? -1 : a.startedAt < b.startedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function buildGraph(runs: readonly GraphRun[], filters: Filters, selectedId: string | null): FlowGraph {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const needle = filters.search.trim().toLowerCase();

  const matches = (r: GraphRun): boolean => {
    if (filters.statuses && !filters.statuses.has(r.status)) return false;
    if (filters.agentIds && !filters.agentIds.has(r.agentId)) return false;
    if (needle === "") return true;
    const hay = [r.agentName, r.id, triggerLabel(r.trigger), ...r.outcomes.flatMap(outcomeTerms)];
    return hay.some((s) => s.toLowerCase().includes(needle));
  };

  // Keep every matching run plus all of its ancestors so trees stay connected.
  const keep = new Set<string>();
  for (const r of runs) {
    if (!matches(r)) continue;
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

  for (const root of roots) {
    const tid = `t:${root.id}`;
    graph.nodes.push({
      id: tid,
      type: "trigger",
      data: { kind: "trigger", trigger: root.trigger, label: triggerLabel(root.trigger) },
    });
    link(tid, `r:${root.id}`, isLive(root));
    emitRun(root);
  }
  return graph;
}
