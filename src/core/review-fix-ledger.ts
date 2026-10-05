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
/** GitHub matches label names case-insensitively, so a PR may report `Wardby-Autofix-1` for a pre-existing repo label. */
const ROUND_LABEL = /^wardby-autofix-([0-9]+)$/i;

/** True when the PR carries `name`, compared case-insensitively as GitHub does. */
function hasLabel(origin: PullRequestOrigin, name: string): boolean {
  const wanted = name.toLowerCase();
  return origin.labels.some((label) => label.toLowerCase() === wanted);
}

/** The round numbers already labeled on the PR, from its current label set. */
function roundNumbers(origin: PullRequestOrigin): number[] {
  return origin.labels
    .map((label) => ROUND_LABEL.exec(label))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
}

export interface FixRoundLedger {
  rounds(origin: PullRequestOrigin): number;
  optedOut(origin: PullRequestOrigin): boolean;
  /** Labels the next unused round number (highest existing + 1), never reusing one already on the PR. */
  recordRound(repository: string, prNumber: number, origin: PullRequestOrigin): Promise<void>;
  /** True only the first time, so the caller comments once. */
  markStopped(repository: string, prNumber: number, origin: PullRequestOrigin): Promise<boolean>;
}

export function fixRoundLedger(host: CodeReviewHost): FixRoundLedger | null {
  if (!host.addLabel) return null;
  const addLabel = host.addLabel.bind(host);
  return {
    rounds: (origin) => roundNumbers(origin).length,
    optedOut: (origin) => hasLabel(origin, OPT_OUT_LABEL),
    recordRound: (repository, prNumber, origin) => {
      // The round count and the label number can diverge (a gap from a label removed by hand,
      // or a race with another delivery), so the next label is always one past the highest
      // number actually on the PR, never derived from the round count: that count is what the
      // caller reports in the task text and heading, but reusing it as a label here could
      // collide with a label already there and make addLabel a silent no-op (the count would
      // then never grow and the cap would never trip).
      const next = Math.max(0, ...roundNumbers(origin)) + 1;
      return addLabel(repository, prNumber, `wardby-autofix-${next}`);
    },
    markStopped: async (repository, prNumber, origin) => {
      if (hasLabel(origin, STOPPED_LABEL)) return false;
      await addLabel(repository, prNumber, STOPPED_LABEL);
      return true;
    },
  };
}
