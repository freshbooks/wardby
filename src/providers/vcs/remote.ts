import type { FinalizeChangesDetails, PreparedWorkspace, VcsProvider } from "./types.js";

/** What a remote needs to publish a pushed commit (GitHub: open or find the draft PR). */
export interface PublishInput {
  /** The validated workspace whose headRef was just pushed. */
  workspace: PreparedWorkspace;
  details?: FinalizeChangesDetails;
  /** Every path the commit changes relative to baseCommit (already validated). */
  changedPaths: readonly string[];
}

export type PublishResult = { kind: "pull_request"; number: number; url: string } | { kind: "branch"; branch: string };

/**
 * The remote-specific half of GitVcsProvider: where a repository is cloned
 * from and pushed to, how git authenticates, and what happens after a push.
 * Everything else (workspace layout, hardened git config, finalize checks,
 * fetch-compare-push) stays in GitVcsProvider and applies to every remote.
 */
export interface GitRemote {
  /** Extra `-c` pairs appended after HARDENED_GIT_CONFIG for clone/push/ls-remote (GitHub: none). */
  readonly gitConfig: readonly string[];
  cloneUrl(repository: string): string;
  /** Runs fn with an auth token for git (GitHub: installation token; local: undefined). */
  withAccess<T>(repository: string, fn: (token: string | undefined) => Promise<T>): Promise<T>;
  /** Continuation precondition (GitHub: the PR is still open). */
  assertContinuationOpen(input: {
    repository: string;
    baseRef: string;
    headRef: string;
    continuation?: { rootRunId: string };
  }): Promise<void>;
  /** After a successful push: GitHub opens or finds the draft PR; local returns the branch. */
  publish(input: PublishInput): Promise<PublishResult>;
  /** The error pushOnce throws when the remote branch moved since the clone. */
  conflictError(): Error;
  notifyContinuationStarted?: VcsProvider["notifyContinuationStarted"];
  notifyContinuationFinished?: VcsProvider["notifyContinuationFinished"];
  readRepositoryFile?: VcsProvider["readRepositoryFile"];
}
