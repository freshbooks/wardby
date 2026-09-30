/**
 * The status comment for a run started by a Jira issue event: "working on
 * it" right after the webhook is answered, edited once with the outcome.
 * Same lifecycle as host-status.ts (GitHub mentions), reusing its outcome
 * text. Best effort throughout: nothing here throws.
 */
import type { Prisma, PrismaClient } from "#prisma";
import type { IssueTrackerProvider, IssueTrackerRegistry } from "../providers/issue-tracker/types.js";
import { collectRunOutcome, outcomeBody, workingBody, type FinishedRun } from "./host-status.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "issue-status" });
const TERMINAL = new Set(["succeeded", "failed", "refused", "lost", "budget_exhausted", "cancelled"]);
const ORPHAN_GRACE_MS = 2 * 60 * 1000;
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ORPHAN_BATCH = 20;

export type IssueStatusDb = Pick<PrismaClient, "runIssueStatus" | "run">;

export function toJiraMarkdown(text: string): string {
  return text
    .replace(/<sub>(.*?)<\/sub>/g, "_$1_")
    .replace(
      /\b([\w.-]+\/[\w.-]+)#(\d+)\b/g,
      (_m, repo: string, n: string) => `[${repo}#${n}](https://github.com/${repo}/pull/${n})`,
    );
}

export function issueStatusRow(
  event: { issueKey: string },
  runId: string,
  visibilityRole: string | null,
): Prisma.RunIssueStatusUncheckedCreateInput {
  return { runId, provider: "jira", issueKey: event.issueKey, visibilityRole };
}

export async function postIssueWorkingStatus(
  db: IssueStatusDb,
  trackers: IssueTrackerRegistry,
  runId: string,
): Promise<void> {
  try {
    const status = await db.runIssueStatus.findUnique({ where: { runId } });
    if (!status || status.commentId || status.completedAt) return;
    const tracker = trackers[status.provider as IssueTrackerProvider];
    if (!tracker) return;
    const posted = await tracker.comment(status.issueKey, {
      markdown: toJiraMarkdown(workingBody(runId)),
      ...(status.visibilityRole ? { visibilityRole: status.visibilityRole } : {}),
    });
    const claimed = await db.runIssueStatus.updateMany({
      where: { runId, commentId: null, completedAt: null },
      data: { commentId: posted.id },
    });
    if (claimed.count === 0) {
      log.warn({ runId }, "status comment posted after the outcome; leaving both");
      return;
    }
    const run = await db.run.findUnique({ where: { id: runId }, select: { id: true, status: true, finalText: true } });
    if (run && TERMINAL.has(run.status)) await completeIssueStatus(db, run, trackers);
  } catch (err) {
    log.warn({ err, runId }, "could not post the issue status comment");
  }
}

export async function completeIssueStatus(
  db: IssueStatusDb,
  run: FinishedRun,
  trackers: IssueTrackerRegistry | undefined,
  opts: { postIfMissing?: boolean } = {},
): Promise<void> {
  if (!trackers) return;
  try {
    const status = await db.runIssueStatus.findUnique({ where: { runId: run.id } });
    if (!status || status.completedAt) return;
    if (!status.commentId && !opts.postIfMissing) return;
    const tracker = trackers[status.provider as IssueTrackerProvider];
    if (!tracker) return;
    const { pullRequests, failedChildren, budgetSentence } = await collectRunOutcome(db, run);
    const markdown = toJiraMarkdown(
      outcomeBody(run, "", pullRequests, failedChildren, { budgetSentence, noPullRequestText: "Done." }),
    );
    let commentId = status.commentId;
    if (commentId) await tracker.editComment(status.issueKey, commentId, { markdown });
    else {
      commentId = (
        await tracker.comment(status.issueKey, {
          markdown,
          ...(status.visibilityRole ? { visibilityRole: status.visibilityRole } : {}),
        })
      ).id;
    }
    await db.runIssueStatus.update({ where: { runId: run.id }, data: { commentId, completedAt: new Date() } });
  } catch (err) {
    log.warn({ err, runId: run.id }, "could not complete the issue status comment");
  }
}

export async function closeOrphanedIssueStatuses(
  db: IssueStatusDb,
  trackers: IssueTrackerRegistry | undefined,
  now: Date = new Date(),
): Promise<void> {
  const providers = Object.keys(trackers ?? {});
  if (!trackers || providers.length === 0) return;
  const orphans = await db.runIssueStatus.findMany({
    where: {
      completedAt: null,
      provider: { in: providers },
      run: {
        status: { notIn: ["pending", "running"] },
        finishedAt: {
          lte: new Date(now.getTime() - ORPHAN_GRACE_MS),
          gte: new Date(now.getTime() - ORPHAN_MAX_AGE_MS),
        },
      },
    },
    select: { run: { select: { id: true, status: true, finalText: true } } },
    orderBy: { run: { finishedAt: "desc" } },
    take: ORPHAN_BATCH,
  });
  for (const { run } of orphans) await completeIssueStatus(db, run, trackers, { postIfMissing: true });
}
