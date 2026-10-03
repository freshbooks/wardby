import type { GraphRun, RunStatus } from "../api/types";

export const WINDOWS = ["15m", "1h", "6h", "24h", "7d"] as const;
export type WindowSize = (typeof WINDOWS)[number];

export const STATUS_GROUPS = ["running", "failed", "succeeded", "pending"] as const;
export type StatusGroup = (typeof STATUS_GROUPS)[number];

/** Milliseconds spanned by each window. */
export const WINDOW_MS: Record<WindowSize, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
};

export interface TimeRange {
  from: number;
  to: number;
}

export interface Filters {
  window: WindowSize;
  /** Enabled status groups. */
  statuses: ReadonlySet<StatusGroup>;
  /** Selected agent ids; empty means all agents. */
  agents: ReadonlySet<string>;
  search: string;
  /** Brushed time range (epoch ms, by run start); null means the whole window. */
  timeRange: TimeRange | null;
}

export const initialFilters: Filters = {
  window: "1h",
  statuses: new Set<StatusGroup>(["running", "failed", "succeeded", "pending"]),
  agents: new Set<string>(),
  search: "",
  timeRange: null,
};

/** Apply a filter change; moving to another window drops the brushed range. */
export function changeFilters(prev: Filters, next: Filters): Filters {
  return next.window !== prev.window && next.timeRange !== null ? { ...next, timeRange: null } : next;
}

export function statusGroup(status: RunStatus): StatusGroup {
  switch (status) {
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "pending":
      return "pending";
    default:
      // failed, budget_exhausted, lost, refused, cancelled
      return "failed";
  }
}

export function matchesFilters(run: GraphRun, filters: Filters, opts: { ignoreTimeRange?: boolean } = {}): boolean {
  if (!filters.statuses.has(statusGroup(run.status))) return false;
  if (filters.timeRange && !opts.ignoreTimeRange) {
    const t = Date.parse(run.startedAt);
    if (!(t >= filters.timeRange.from && t <= filters.timeRange.to)) return false;
  }
  if (filters.agents.size > 0 && !filters.agents.has(run.agentId)) return false;
  const q = filters.search.trim().toLowerCase();
  if (q && !run.id.toLowerCase().includes(q) && !run.agentName.toLowerCase().includes(q)) return false;
  return true;
}

export function countByGroup(runs: Iterable<GraphRun>): Record<StatusGroup, number> {
  const counts: Record<StatusGroup, number> = { running: 0, failed: 0, succeeded: 0, pending: 0 };
  for (const run of runs) counts[statusGroup(run.status)] += 1;
  return counts;
}

/** Runs matching the filters plus their ancestors, so run trees stay connected. */
export function visibleRuns(runs: readonly GraphRun[], filters: Filters): GraphRun[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const keep = new Set<string>();
  for (const r of runs) {
    if (!matchesFilters(r, filters)) continue;
    let cur: GraphRun | undefined = r;
    while (cur && !keep.has(cur.id)) {
      keep.add(cur.id);
      cur = cur.parentRunId === null ? undefined : byId.get(cur.parentRunId);
    }
  }
  return runs.filter((r) => keep.has(r.id));
}
