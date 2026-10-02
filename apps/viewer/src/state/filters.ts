import type { GraphRun, RunStatus } from "../api/types";

export const WINDOWS = ["15m", "1h", "6h", "24h", "7d"] as const;
export type WindowSize = (typeof WINDOWS)[number];

export const STATUS_GROUPS = ["running", "failed", "succeeded", "pending"] as const;
export type StatusGroup = (typeof STATUS_GROUPS)[number];

export interface Filters {
  window: WindowSize;
  /** Enabled status groups. */
  statuses: ReadonlySet<StatusGroup>;
  /** Selected agent ids; empty means all agents. */
  agents: ReadonlySet<string>;
  search: string;
}

export const initialFilters: Filters = {
  window: "1h",
  statuses: new Set<StatusGroup>(["running", "failed", "succeeded", "pending"]),
  agents: new Set<string>(),
  search: "",
};

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

export function matchesFilters(run: GraphRun, filters: Filters): boolean {
  if (!filters.statuses.has(statusGroup(run.status))) return false;
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
