export const WORKFLOW_EVENT_KINDS = [
  "issue_picked_up",
  "run_failed",
  "pr_opened",
  "review_posted",
  "review_fix",
  "pr_closed",
] as const;
export type WorkflowEventKind = (typeof WORKFLOW_EVENT_KINDS)[number];

/** Template inputs per kind. Every string here may be shown in Slack (escaped). */
export type WorkflowPayload =
  | { kind: "issue_picked_up"; agentName: string; trigger: string }
  | {
      kind: "run_failed";
      agentName: string;
      status: "failed" | "budget_exhausted" | "cancelled" | "lost";
      reason: string | null;
    }
  | { kind: "pr_opened"; prLabel: string; prUrl: string; movedTo: string | null }
  | {
      kind: "review_posted";
      agentName: string;
      verdict: "APPROVE" | "CHANGES_REQUESTED" | "COMMENT";
      prLabel: string;
      prUrl: string | null;
      ciPending: boolean;
    }
  | { kind: "review_fix"; prLabel: string; round: number; maxRounds: number; state: "started" | "capped" }
  | { kind: "pr_closed"; prLabel: string; prUrl: string; merged: boolean; movedTo: string | null };

/** What a thread's parent message shows about its subject. */
export interface ThreadSubject {
  /** "PAY-241" or "org/repo#212" or "run abc123". */
  label: string;
  title: string | null;
  url: string | null;
}

export const dedupeKeys = {
  issuePickedUp: (runId: string) => `issue_picked_up:${runId}`,
  runFailed: (runId: string) => `run_failed:${runId}`,
  prOpened: (codeProvider: string, repository: string, n: number) => `pr_opened:${codeProvider}:${repository}#${n}`,
  reviewPosted: (runId: string) => `review_posted:${runId}`,
  reviewFix: (repository: string, n: number, round: number, state: "started" | "capped") =>
    `review_fix:${repository}#${n}:${round}:${state}`,
  prClosed: (codeProvider: string, repository: string, n: number) => `pr_closed:${codeProvider}:${repository}#${n}`,
};

export const threadKeys = {
  issue: (provider: string, key: string) => `issue:${provider}:${key}`,
  pr: (codeProvider: string, repository: string, n: number) => `pr:${codeProvider}:${repository}#${n}`,
  run: (runId: string) => `run:${runId}`,
};

/** First line of an error, at most 200 characters; null for empty. */
export function shortReason(error: string | null | undefined): string | null {
  const first = (error ?? "").split("\n", 1)[0].trim();
  return first ? first.slice(0, 200) : null;
}
