/** Host-neutral CI summary for repo_pr_read. */
import type { CiCheckView, CiState } from "./types.js";

/** Most CI results listed on one head. */
export const MAX_CI_CHECKS = 50;
export const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "timed_out",
  "action_required",
  "startup_failure",
  "error",
]);
export const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);

export function summarizeCi(checks: readonly CiCheckView[]): Exclude<CiState, "unavailable"> {
  if (checks.length === 0) return "none";
  if (checks.some((c) => c.status === "completed" && FAILING_CONCLUSIONS.has(c.conclusion ?? ""))) return "failing";
  if (checks.some((c) => c.status !== "completed")) return "pending";
  const allPassing = checks.every((c) => PASSING_CONCLUSIONS.has(c.conclusion ?? ""));
  return allPassing && checks.some((c) => c.conclusion === "success") ? "passing" : "inconclusive";
}
