import type { GraphRun } from "../api/types";
import { formatUsd } from "../format/money";
import { matchesFilters, type Filters } from "./filters";

export interface ShownCost {
  /** Runs that match every filter; ancestors shown only to keep a tree connected are excluded. */
  matching: GraphRun[];
  shown: number;
  byAgent: { agentName: string; costUsd: number }[];
}

export function shownCost(runs: Iterable<GraphRun>, filters: Filters): ShownCost {
  const matching: GraphRun[] = [];
  const perAgent = new Map<string, number>();
  let shown = 0;
  for (const run of runs) {
    if (!matchesFilters(run, filters)) continue;
    matching.push(run);
    shown += run.costUsd;
    perAgent.set(run.agentName, (perAgent.get(run.agentName) ?? 0) + run.costUsd);
  }
  const byAgent = [...perAgent]
    .map(([agentName, costUsd]) => ({ agentName, costUsd }))
    .sort((a, b) => b.costUsd - a.costUsd || a.agentName.localeCompare(b.agentName));
  return { matching, shown, byAgent };
}

const BREAKDOWN_TOP = 8;

export function breakdownText(byAgent: ShownCost["byAgent"]): string {
  const parts = byAgent.slice(0, BREAKDOWN_TOP).map((a) => `${a.agentName} ${formatUsd(a.costUsd)}`);
  if (byAgent.length > BREAKDOWN_TOP) parts.push(`+${byAgent.length - BREAKDOWN_TOP} more`);
  return parts.join(" · ");
}
