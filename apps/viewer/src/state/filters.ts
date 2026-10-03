import type { GraphRun, RunStatus } from "../api/types";
import { outcomeTerms, triggerLabel } from "../graph/labels";

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

/**
 * The one run-matching rule shared by the graph, counts, cost and timeline: status group, agents,
 * search (agent name, run id, trigger label, outcome terms) and brushed range (unless ignored).
 */
export function matchesFilters(run: GraphRun, filters: Filters, opts: { ignoreTimeRange?: boolean } = {}): boolean {
  if (!filters.statuses.has(statusGroup(run.status))) return false;
  if (filters.timeRange && !opts.ignoreTimeRange) {
    const t = Date.parse(run.startedAt);
    if (!(t >= filters.timeRange.from && t <= filters.timeRange.to)) return false;
  }
  if (filters.agents.size > 0 && !filters.agents.has(run.agentId)) return false;
  const q = filters.search.trim().toLowerCase();
  if (q === "") return true;
  const hay = [run.agentName, run.id, triggerLabel(run.trigger), ...run.outcomes.flatMap(outcomeTerms)];
  return hay.some((s) => s.toLowerCase().includes(q));
}

export function countByGroup(runs: Iterable<GraphRun>): Record<StatusGroup, number> {
  const counts: Record<StatusGroup, number> = { running: 0, failed: 0, succeeded: 0, pending: 0 };
  for (const run of runs) counts[statusGroup(run.status)] += 1;
  return counts;
}
