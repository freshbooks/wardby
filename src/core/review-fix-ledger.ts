/**
 * Counts automatic review fix rounds per pull request. On a host with labels
 * (GitHub) the count lives on the PR itself, visible and resettable by a
 * person: one `wardby-autofix-<N>` label per round, `wardby-autofix-limit`
 * once wardby has stopped, `wardby-autofix-off` to opt a PR out. A host
 * without labels gets a database ledger when it is supported; until then
 * fixRoundLedger returns null and no rounds start there.
 */
import type { CodeReviewHost, PullRequestOrigin } from "../providers/review-host/types.js";

export const STOPPED_LABEL = "wardby-autofix-limit";
export const OPT_OUT_LABEL = "wardby-autofix-off";
const ROUND_LABEL = /^wardby-autofix-[0-9]+$/;

export interface FixRoundLedger {
  rounds(origin: PullRequestOrigin): number;
  optedOut(origin: PullRequestOrigin): boolean;
  recordRound(repository: string, prNumber: number, round: number): Promise<void>;
  /** True only the first time, so the caller comments once. */
  markStopped(repository: string, prNumber: number, origin: PullRequestOrigin): Promise<boolean>;
}

export function fixRoundLedger(host: CodeReviewHost): FixRoundLedger | null {
  if (!host.addLabel) return null;
  const addLabel = host.addLabel.bind(host);
  return {
    rounds: (origin) => origin.labels.filter((label) => ROUND_LABEL.test(label)).length,
    optedOut: (origin) => origin.labels.includes(OPT_OUT_LABEL),
    recordRound: (repository, prNumber, round) => addLabel(repository, prNumber, `wardby-autofix-${round}`),
    markStopped: async (repository, prNumber, origin) => {
      if (origin.labels.includes(STOPPED_LABEL)) return false;
      await addLabel(repository, prNumber, STOPPED_LABEL);
      return true;
    },
  };
}
