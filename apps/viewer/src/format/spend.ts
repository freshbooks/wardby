import { formatUsd } from "./money";

/** Total cost of the runs currently in the window. */
export function windowSpend(runs: Iterable<{ costUsd: number }>): number {
  let total = 0;
  for (const r of runs) total += r.costUsd;
  return total;
}

/** A truncated snapshot holds only the most recent runs, so its total is a lower bound. */
export function formatWindowTotal(total: number, truncated: boolean): string {
  return `${truncated ? "≥" : ""}${formatUsd(total)}`;
}

export const TRUNCATED_TITLE = "Only the most recent 500 runs are loaded; the window total may be higher.";
