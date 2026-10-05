/**
 * A coding continuation whose pull request is no longer open (merged or
 * closed) pushes nothing: git.ts checks before cloning and again before the
 * push. These are the fixed texts the delegating agent and status comments see.
 */
export const CONTINUATION_CLOSED_ERROR = "vcs_continuation_pull_request_not_open";
export const CONTINUATION_CLOSED_CATEGORY = "continuation_closed";
export const CONTINUATION_CLOSED_SENTENCE =
  "The pull request this run was asked to continue is no longer open (merged or closed), so nothing was pushed. " +
  "If the change is still needed, delegate again without continuePriorRun: it becomes a new pull request from the default branch.";
export const CONTINUATION_CLOSED_HOST_LINE =
  "A sub-run was asked to continue a pull request that is no longer open (merged or closed); nothing was pushed.";

export function isContinuationClosedError(error: string | null | undefined): boolean {
  return typeof error === "string" && error.startsWith(`coding_failure_${CONTINUATION_CLOSED_CATEGORY}:`);
}
