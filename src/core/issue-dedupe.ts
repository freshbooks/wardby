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
 * Concurrency: a Postgres advisory transaction lock on (provider, project,
 * hash) serialises find -> decide -> tracker call -> row write, so concurrent
 * calls with one fingerprint create at most one issue. Control-plane actions
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
} from "../providers/issue-tracker/types.js";

const log = logger.child({ module: "issue-dedupe" });

export const FINGERPRINT_MAX_LENGTH = 200;
/** Long enough for a tracker read plus a create with its retries, short enough not to pin a connection. */
export const DEDUPE_TRANSACTION_TIMEOUT_MS = 30_000;
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
}

export type FileIssueOutcome = "created" | "seen_again" | "regression";
export type FileIssueResult =
  { outcome: FileIssueOutcome; issueKey: string; url: string; seenCount: number } | { error: string; message: string };

export function fingerprintHash(fingerprint: string): string {
  return createHash("sha256").update(fingerprint, "utf8").digest("hex");
}

/** A stable signed 64-bit advisory-lock key for one (provider, project, hash). */
export function dedupeLockKey(provider: string, projectKey: string, hash: string): bigint {
  const digest = createHash("sha256").update(`wardby:issue-dedupe:${provider}:${projectKey}:${hash}`).digest();
  return digest.readBigInt64BE(0);
}

const REGRESSION_LINK_TYPE = "relates";

export async function fileIssue(deps: { db: IssueDedupeDb }, input: FileIssueInput): Promise<FileIssueResult> {
  const { link, tracker } = input;
  try {
    if (link.access !== "write") {
      return { error: "permission_denied", message: `Creating issues in ${link.projectKey} needs a write link.` };
    }
    if (link.provider !== tracker.provider) {
      return { error: "invalid_arguments", message: "The link and tracker providers differ." };
    }
    const createInput: CreateIssueInput = { ...input.create, projectKey: link.projectKey };
    const fingerprint = input.fingerprint ?? undefined;
    if (fingerprint === undefined) {
      const created = await tracker.createIssue(createInput);
      return { outcome: "created", issueKey: created.key, url: created.url, seenCount: 1 };
    }
    if (fingerprint.length < 1 || fingerprint.length > FINGERPRINT_MAX_LENGTH) {
      return {
        error: "invalid_arguments",
        message: `fingerprint must be 1-${FINGERPRINT_MAX_LENGTH} characters.`,
      };
    }
    const hash = fingerprintHash(fingerprint);
    const lockKey = dedupeLockKey(link.provider, link.projectKey, hash);

    return await deps.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;
        const previous = await tx.issueFingerprint.findFirst({
          where: { issueProvider: link.provider, projectKey: link.projectKey, fingerprintHash: hash },
          orderBy: [{ firstSeenAt: "desc" }, { id: "desc" }],
        });

        let regressionOf: string | undefined;
        if (previous) {
          const view = await currentIssue(tracker, previous.issueKey);
          if (view && view.projectKey === link.projectKey) {
            if (view.statusCategory !== "done") {
              const seenCount = previous.seenCount + 1;
              await tracker.comment(previous.issueKey, {
                markdown: `${input.seenAgainMarkdown}\n\nSeen again (×${seenCount})`,
                ...(link.commentVisibilityRole ? { visibilityRole: link.commentVisibilityRole } : {}),
              });
              await tx.issueFingerprint.update({
                where: { id: previous.id },
                data: { seenCount, lastSeenAt: new Date() },
              });
              return { outcome: "seen_again", issueKey: previous.issueKey, url: view.url, seenCount };
            }
            regressionOf = previous.issueKey;
          }
        }

        const created = await tracker.createIssue(
          regressionOf
            ? {
                ...createInput,
                descriptionMarkdown: `${createInput.descriptionMarkdown}\n\nRegression of ${regressionOf}.`,
              }
            : createInput,
        );
        await tx.issueFingerprint.create({
          data: {
            issueProvider: link.provider,
            projectKey: link.projectKey,
            fingerprintHash: hash,
            issueKey: created.key,
            agentId: input.agentId,
            createdByRunId: input.runId ?? null,
          },
        });
        if (regressionOf) {
          await linkRegression(tracker, created.key, regressionOf, input.agentId);
          return { outcome: "regression", issueKey: created.key, url: created.url, seenCount: 1 };
        }
        return { outcome: "created", issueKey: created.key, url: created.url, seenCount: 1 };
      },
      { timeout: DEDUPE_TRANSACTION_TIMEOUT_MS, maxWait: DEDUPE_TRANSACTION_MAX_WAIT_MS },
    );
  } catch (err) {
    if (err instanceof IssueTrackerError) return { error: err.code, message: err.message };
    log.warn({ err, agentId: input.agentId, projectKey: link.projectKey }, "issue dedupe failed");
    return { error: "internal_error", message: "Filing the issue failed." };
  }
}

/** The issue as it is now, or null when it no longer exists. */
async function currentIssue(tracker: IssueTracker, key: string): Promise<IssueView | null> {
  try {
    return await tracker.getIssue(key, { maxComments: 0, agentMarker: "" });
  } catch (err) {
    if (err instanceof IssueTrackerError && err.code === "tracker_not_found") return null;
    throw err;
  }
}

/** New relates to old. Best effort: the description already names the old issue. */
async function linkRegression(tracker: IssueTracker, newKey: string, oldKey: string, agentId: string): Promise<void> {
  try {
    const type = (await tracker.linkTypes()).find((t) => t.name.toLowerCase() === REGRESSION_LINK_TYPE);
    if (!type) return;
    await tracker.linkIssues({ type: type.name, inwardKey: oldKey, outwardKey: newKey });
  } catch (err) {
    log.warn({ err, agentId, newKey, oldKey }, "regression link failed");
  }
}
