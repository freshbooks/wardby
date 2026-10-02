/**
 * Fingerprint dedupe for issue creation, shared by jira_create_issue and
 * self-defects. A fingerprint (opaque, 1-200 chars) is stored only as its
 * sha256 hex in IssueFingerprint; the raw value never reaches the tracker.
 *
 *   no fingerprint                      -> create
 *   no earlier issue (or it is gone,
 *     or it moved out of the project)   -> create            ("created")
 *   earlier issue still open            -> comment on it      ("seen_again")
 *   earlier issue Done                  -> create a new one, link it to the
 *                                          old one ("Relates"), old untouched
 *                                                            ("regression")
 *
 * With createAllowed: false (a caller at its creation cap) only the
 * seen-again update happens; where it would create (or file a regression)
 * it returns { error: "issue_cap_reached" } and makes no tracker write.
 *
 * Concurrency: a Postgres advisory transaction lock on (provider, project,
 * hash) serialises find -> decide -> tracker call -> row write, so concurrent
 * calls with one fingerprint create at most one issue. Every tracker call in
 * that critical section is bounded (TRACKER_CALL_OPTIONS) and the transaction
 * timeout sits well above their sum, so the lock is never released (by a
 * timed-out transaction) while a create is still in flight. The regression
 * link is made after commit, outside the lock. Control-plane actions
 * here (the regression link, the seen-again comment) are not gated by the
 * link's allowlists but only ever act in a project the agent has a write link
 * to. Never throws: failures come back as { error, message }.
 */
import { createHash } from "node:crypto";
import type { PrismaClient } from "#prisma";
import { logger } from "./logger.js";
import {
  type CreateIssueInput,
  type IssueTracker,
  IssueTrackerError,
  type IssueView,
  type TrackerCallOptions,
} from "../providers/issue-tracker/types.js";

const log = logger.child({ module: "issue-dedupe" });

export const FINGERPRINT_MAX_LENGTH = 200;
/** Each tracker call inside the lock: a whole-call cap, and a 429 fails at once rather than sleeping. */
export const TRACKER_CALL_OPTIONS: Readonly<TrackerCallOptions> = { timeoutMs: 10_000, retryOn429: false };
/** How long a sighting waits for another sighting of the same fingerprint before answering "busy". */
export const DEDUPE_LOCK_TIMEOUT_MS = 5_000;
/**
 * The critical section is the lock wait (5 s) plus at most two bounded tracker calls (getIssue, then
 * createIssue or comment: 2 x 10 s) plus a few row reads/writes; 60 s leaves ample margin so a create is
 * never in flight when the transaction (and with it the advisory lock) is torn down. The cost: each
 * sighting in progress holds one pool connection for up to this long, and waiters hold one for up to
 * the lock timeout (callers waiting for a free connection give up after maxWait).
 */
export const DEDUPE_TRANSACTION_TIMEOUT_MS = 60_000;
const DEDUPE_TRANSACTION_MAX_WAIT_MS = 10_000;

export type IssueDedupeDb = Pick<PrismaClient, "$transaction">;

export interface IssueDedupeLink {
  provider: string;
  projectKey: string;
  access: string;
  commentVisibilityRole?: string | null;
}

export interface FileIssueInput {
  agentId: string;
  runId?: string | null;
  link: IssueDedupeLink;
  tracker: IssueTracker;
  fingerprint?: string | null;
  /** Everything but the project, which comes from the link. */
  create: Omit<CreateIssueInput, "projectKey">;
  /** Posted on the existing issue when the fingerprint is seen again. */
  seenAgainMarkdown: string;
  /** false: only a seen-again update may happen; a create or regression returns issue_cap_reached. Default true. */
  createAllowed?: boolean;
}

export type FileIssueOutcome = "created" | "seen_again" | "regression";
export type FileIssueSuccess = { outcome: FileIssueOutcome; issueKey: string; url: string; seenCount: number };
export type FileIssueResult = FileIssueSuccess | { error: string; message: string };

export const BUSY_RESULT = {
  error: "busy",
  message: "another sighting of this fingerprint is being filed; try again",
} as const;

/** Thrown inside the transaction to abort a create the caller disallowed (nothing was written). */
class CreateNotAllowed extends Error {}

export function fingerprintHash(fingerprint: string): string {
  return createHash("sha256").update(fingerprint, "utf8").digest("hex");
}

/** A stable signed 64-bit advisory-lock key for one (provider, project, hash). */
export function dedupeLockKey(provider: string, projectKey: string, hash: string): bigint {
  const digest = createHash("sha256").update(`wardby:issue-dedupe:${provider}:${projectKey}:${hash}`).digest();
  return digest.readBigInt64BE(0);
}

const REGRESSION_LINK_TYPE = "relates";

export async function fileIssue(
  deps: { db: IssueDedupeDb; lockTimeoutMs?: number },
  input: FileIssueInput,
): Promise<FileIssueResult> {
  const { link, tracker } = input;
  // Set once the tracker side is done (issue created / comment posted), so a later row failure still reports it:
  // answering with an error would make the caller retry and file a duplicate.
  let completed: FileIssueSuccess | undefined;
  let regressionOf: string | undefined;
  // The tracker's own URL for the Done issue (never model input), so the new issue links back to it.
  let regressionOfUrl: string | undefined;
  let hash: string | undefined;
  try {
    if (link.access !== "write") {
      return { error: "permission_denied", message: `Creating issues in ${link.projectKey} needs a write link.` };
    }
    if (link.provider !== tracker.provider) {
      return { error: "invalid_arguments", message: "The link and tracker providers differ." };
    }
    const createInput: CreateIssueInput = { ...input.create, projectKey: link.projectKey };
    const fingerprint = input.fingerprint ?? undefined;
    const createAllowed = input.createAllowed ?? true;
    if (fingerprint === undefined) {
      if (!createAllowed) return capReached(link.projectKey);
      const created = await tracker.createIssue(createInput);
      return { outcome: "created", issueKey: created.key, url: created.url, seenCount: 1 };
    }
    if (fingerprint.length < 1 || fingerprint.length > FINGERPRINT_MAX_LENGTH) {
      return {
        error: "invalid_arguments",
        message: `fingerprint must be 1-${FINGERPRINT_MAX_LENGTH} characters.`,
      };
    }
    const fpHash = fingerprintHash(fingerprint);
    hash = fpHash;
    const lockKey = dedupeLockKey(link.provider, link.projectKey, fpHash);
    const lockTimeoutMs = Math.max(1, Math.trunc(deps.lockTimeoutMs ?? DEDUPE_LOCK_TIMEOUT_MS));

    const result = await deps.db.$transaction(
      async (tx): Promise<FileIssueSuccess> => {
        // Transaction-local: bounds the wait for the advisory lock below.
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;
        const previous = await tx.issueFingerprint.findFirst({
          where: { issueProvider: link.provider, projectKey: link.projectKey, fingerprintHash: fpHash },
          orderBy: [{ firstSeenAt: "desc" }, { id: "desc" }],
        });

        if (previous) {
          const view = await currentIssue(tracker, previous.issueKey);
          // A moved issue (now in another project) is not reused. Known limitation: renaming the project's key
          // makes every earlier issue look moved too (Jira answers with the new key while the link keeps the old
          // one), so each sighting files a new issue until the link is re-pointed at the new key.
          if (view && view.projectKey === link.projectKey) {
            if (view.statusCategory !== "done") {
              const seenCount = previous.seenCount + 1;
              await tracker.comment(
                previous.issueKey,
                {
                  markdown: `${input.seenAgainMarkdown}\n\nSeen again (×${seenCount})`,
                  ...(link.commentVisibilityRole ? { visibilityRole: link.commentVisibilityRole } : {}),
                },
                TRACKER_CALL_OPTIONS,
              );
              completed = { outcome: "seen_again", issueKey: previous.issueKey, url: view.url, seenCount };
              await tx.issueFingerprint.update({
                where: { id: previous.id },
                data: { seenCount, lastSeenAt: new Date() },
              });
              return completed;
            }
            regressionOf = previous.issueKey;
            regressionOfUrl = view.url;
          }
        }

        if (!createAllowed) throw new CreateNotAllowed();
        // Not idempotent: if the bounded POST is aborted after Jira already committed the issue, this transaction
        // rolls back with no fingerprint row, and a retry files a second issue. Inherent to timing out a create
        // (Jira has no idempotency key for it); the timeout keeps the advisory lock from being held indefinitely.
        const created = await tracker.createIssue(
          regressionOf
            ? {
                ...createInput,
                descriptionMarkdown: `${createInput.descriptionMarkdown}\n\nRegression of ${regressionOfUrl?.startsWith("https://") ? `[${regressionOf}](${regressionOfUrl})` : regressionOf}.`,
              }
            : createInput,
          TRACKER_CALL_OPTIONS,
        );
        completed = {
          outcome: regressionOf ? "regression" : "created",
          issueKey: created.key,
          url: created.url,
          seenCount: 1,
        };
        await tx.issueFingerprint.create({
          data: {
            issueProvider: link.provider,
            projectKey: link.projectKey,
            fingerprintHash: fpHash,
            issueKey: created.key,
            agentId: input.agentId,
            createdByRunId: input.runId ?? null,
          },
        });
        return completed;
      },
      { timeout: DEDUPE_TRANSACTION_TIMEOUT_MS, maxWait: DEDUPE_TRANSACTION_MAX_WAIT_MS },
    );
    if (result.outcome === "regression" && regressionOf) {
      await linkRegression(tracker, result.issueKey, regressionOf, input.agentId);
    }
    return result;
  } catch (err) {
    if (completed) {
      // The tracker side happened; only the bookkeeping did not. Report what was done (hash only, never the raw value).
      log.warn(
        {
          err,
          agentId: input.agentId,
          issueKey: completed.issueKey,
          fingerprintHash: hash,
          outcome: completed.outcome,
        },
        "issue dedupe: tracker action done but its fingerprint row was not saved",
      );
      if (completed.outcome === "regression" && regressionOf) {
        await linkRegression(tracker, completed.issueKey, regressionOf, input.agentId);
      }
      return completed;
    }
    if (err instanceof CreateNotAllowed) return capReached(link.projectKey);
    if (isLockTimeout(err)) return { ...BUSY_RESULT };
    if (err instanceof IssueTrackerError) return { error: err.code, message: err.message };
    log.warn({ err, agentId: input.agentId, projectKey: link.projectKey }, "issue dedupe failed");
    return { error: "internal_error", message: "Filing the issue failed." };
  }
}

function capReached(projectKey: string): { error: string; message: string } {
  return {
    error: "issue_cap_reached",
    message: `This run has reached its limit of new issues in ${projectKey} (maxNewIssuesPerRun); nothing was created.`,
  };
}

/** The issue as it is now, or null when it no longer exists. */
async function currentIssue(tracker: IssueTracker, key: string): Promise<IssueView | null> {
  try {
    return await tracker.getIssue(key, { maxComments: 0, agentMarker: "", ...TRACKER_CALL_OPTIONS });
  } catch (err) {
    if (err instanceof IssueTrackerError && err.code === "tracker_not_found") return null;
    throw err;
  }
}

/** Postgres lock_not_available (55P03), as raised when lock_timeout expires, however the driver wraps it. */
export function isLockTimeout(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 5; depth++) {
    const o = e as { code?: unknown; message?: unknown; meta?: unknown; cause?: unknown };
    if (o.code === "55P03") return true;
    if (typeof o.message === "string" && /\b55P03\b|lock timeout/i.test(o.message)) return true;
    const meta = o.meta as { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
    if (meta?.code === "55P03" || meta?.driverAdapterError?.cause?.originalCode === "55P03") return true;
    e = o.cause;
  }
  return false;
}

/** New relates to old, after commit and outside the lock. Best effort: the description already names the old issue. */
async function linkRegression(tracker: IssueTracker, newKey: string, oldKey: string, agentId: string): Promise<void> {
  try {
    const type = (await tracker.linkTypes(TRACKER_CALL_OPTIONS)).find(
      (t) => t.name.toLowerCase() === REGRESSION_LINK_TYPE,
    );
    if (!type) return;
    await tracker.linkIssues({ type: type.name, inwardKey: oldKey, outwardKey: newKey }, TRACKER_CALL_OPTIONS);
  } catch (err) {
    log.warn({ err, agentId, newKey, oldKey }, "regression link failed");
  }
}
