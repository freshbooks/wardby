/**
 * Links a run's pull requests to the issue that started it: records each
 * issue/PR pair, puts a web link on the issue, and applies the link's
 * configured status move. Provider-neutral: a code host is only ever
 * { provider, repository, number }. The issue key comes from the run tree
 * (RunIssueStatus), never from model output. The status move is a control-plane
 * action (not gated by allowedTransitions). Nothing here throws, except
 * handlePullRequestClosed's lookup before it has claimed anything (so the
 * webhook delivery is rolled back and redelivered).
 */
import { Prisma, type PrismaClient } from "#prisma";
import {
  projectOf,
  type IssueTracker,
  type IssueTrackerProvider,
  type IssueTrackerRegistry,
} from "../providers/issue-tracker/types.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "issue-bridge" });

export type IssueBridgeDb = Pick<PrismaClient, "issuePullRequest">;
export type PullRequestClosedDb = Pick<PrismaClient, "issuePullRequest" | "agentIssueProject">;

export interface BridgedPullRequest {
  codeProvider: string;
  repository: string;
  number: number;
  url: string;
  openedByRunId: string;
  outcome: "pull_request_opened" | "pull_request_updated";
}

export interface RecordPullRequestsInput {
  issueKey: string;
  issueProvider: string;
  agentId: string;
  /** The status the link moves the issue to when a pull request is opened, if configured. */
  onPullRequestOpened?: string | null;
  pullRequests: BridgedPullRequest[];
}

export const pullRequestGlobalId = (pr: Pick<BridgedPullRequest, "codeProvider" | "repository" | "number">): string =>
  `wardby:pr:${pr.codeProvider}:${pr.repository}#${pr.number}`;

type PairState = "created" | "open" | "settled" | "unknown";

/**
 * Makes sure the issue/PR pair has a row, without ever overwriting one: a new
 * row is "created"; an existing open one gets its url refreshed ("open"); a
 * merged or closed one is left alone ("settled"). A lost create race (P2002)
 * reads back the winner's row. "unknown" when the store could not be read.
 */
async function ensurePair(
  db: IssueBridgeDb,
  input: RecordPullRequestsInput,
  pr: BridgedPullRequest,
): Promise<PairState> {
  const where = {
    codeProvider_repository_number_issueProvider_issueKey: {
      codeProvider: pr.codeProvider,
      repository: pr.repository,
      number: pr.number,
      issueProvider: input.issueProvider,
      issueKey: input.issueKey,
    },
  };
  try {
    let existing = await db.issuePullRequest.findUnique({ where, select: { state: true } });
    if (!existing) {
      try {
        await db.issuePullRequest.create({
          data: {
            issueProvider: input.issueProvider,
            issueKey: input.issueKey,
            codeProvider: pr.codeProvider,
            repository: pr.repository,
            number: pr.number,
            url: pr.url,
            agentId: input.agentId,
            openedByRunId: pr.openedByRunId,
          },
        });
        return "created";
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
        existing = await db.issuePullRequest.findUnique({ where, select: { state: true } });
        if (!existing) return "unknown";
      }
    }
    if (existing.state !== "open") return "settled";
    await db.issuePullRequest.update({ where, data: { url: pr.url } });
    return "open";
  } catch (err) {
    log.warn(
      { err, issueKey: input.issueKey, repository: pr.repository, number: pr.number },
      "could not record the issue/PR pair",
    );
    return "unknown";
  }
}

/**
 * Returns sentences for the outcome comment (a refused status move); empty
 * when there is nothing to say. Safe to repeat (a retried completion): each
 * pair's side effects happen once — the status move only when this call newly
 * recorded an opened pull request, and a merged/closed pair is never re-linked
 * (re-posting its web link would un-resolve it). An unreadable store skips
 * both rather than risk repeating them.
 */
export async function recordPullRequests(
  db: IssueBridgeDb,
  tracker: IssueTracker,
  input: RecordPullRequestsInput,
): Promise<{ notes: string[] }> {
  const notes: string[] = [];
  try {
    let newlyOpened = false;
    for (const pr of input.pullRequests) {
      const state = await ensurePair(db, input, pr);
      if (state === "created" && pr.outcome === "pull_request_opened") newlyOpened = true;
      if (state !== "created" && state !== "open") continue;
      try {
        await tracker.addRemoteLink(input.issueKey, {
          globalId: pullRequestGlobalId(pr),
          url: pr.url,
          title: `${pr.repository}#${pr.number}`,
        });
      } catch (err) {
        log.warn(
          { err, issueKey: input.issueKey, repository: pr.repository, number: pr.number },
          "could not link the pull request on the issue",
        );
      }
    }
    const target = input.onPullRequestOpened;
    if (target && newlyOpened) {
      try {
        await tracker.transitionTo(input.issueKey, target);
      } catch (err) {
        log.warn({ err, issueKey: input.issueKey, target }, "could not move the issue after a pull request opened");
        notes.push(`Could not move ${input.issueKey} to "${target}"; it may need a manual move.`);
      }
    }
  } catch (err) {
    log.warn({ err, issueKey: input.issueKey }, "could not bridge the pull requests to the issue");
  }
  return { notes };
}

export interface ClosedPullRequest {
  codeProvider: string;
  repository: string;
  number: number;
  merged: boolean;
}

/**
 * A pull request wardby recorded against an issue was merged or closed: marks
 * each still-open pair, and, where the agent's link to the issue's project is
 * still write, comments on the issue (and on merge resolves the web link and
 * applies the link's onPullRequestMerged move). Only rows wardby wrote are
 * touched, matched by the host's own identity for the PR — nothing from the
 * PR's text. The row is claimed first (open → merged/closed), so a duplicate
 * or concurrent delivery finds nothing to do. Throws only when the lookup of
 * linked rows fails — before anything is claimed — so the caller's webhook
 * delivery is rolled back and redelivered; never throws after that.
 */
export async function handlePullRequestClosed(
  db: PullRequestClosedDb,
  trackers: IssueTrackerRegistry | undefined,
  pr: ClosedPullRequest,
): Promise<void> {
  if (!trackers) return;
  const where = { codeProvider: pr.codeProvider, repository: pr.repository, number: pr.number };
  // Not caught: nothing is claimed yet, and a throw rolls back the delivery so it is redelivered.
  const rows = await db.issuePullRequest.findMany({ where: { ...where, state: "open" } });
  for (const row of rows) {
    try {
      const claimed = await db.issuePullRequest.updateMany({
        where: { id: row.id, state: "open" },
        data: { state: pr.merged ? "merged" : "closed" },
      });
      if (claimed.count === 0) continue;
      const tracker = trackers[row.issueProvider as IssueTrackerProvider];
      if (!tracker) continue;
      const link = await db.agentIssueProject.findUnique({
        where: {
          agentId_provider_projectKey: {
            agentId: row.agentId,
            provider: row.issueProvider,
            projectKey: projectOf(row.issueKey),
          },
        },
        select: { access: true, commentVisibilityRole: true, onPullRequestMerged: true },
      });
      if (link?.access !== "write") continue;
      const ref = `[${row.repository}#${row.number}](${row.url})`;
      let markdown: string;
      if (pr.merged) {
        await tracker
          .addRemoteLink(row.issueKey, {
            globalId: pullRequestGlobalId(row),
            url: row.url,
            title: `${row.repository}#${row.number}`,
            status: { resolved: true },
          })
          .catch((err: unknown) =>
            log.warn({ err, issueKey: row.issueKey, ...where }, "could not resolve the pull request's web link"),
          );
        markdown = `✅ Pull request ${ref} was merged.`;
        const target = link.onPullRequestMerged;
        if (target) {
          try {
            const moved = await tracker.transitionTo(row.issueKey, target);
            markdown += ` Moved to ${moved.toStatus}.`;
          } catch (err) {
            log.warn({ err, issueKey: row.issueKey, target }, "could not move the issue after its pull request merged");
            markdown += ` Could not move ${row.issueKey} to "${target}"; it may need a manual move.`;
          }
        }
      } else {
        markdown = `Pull request ${ref} was closed without merging.`;
      }
      await tracker.comment(row.issueKey, {
        markdown,
        ...(link.commentVisibilityRole ? { visibilityRole: link.commentVisibilityRole } : {}),
      });
    } catch (err) {
      log.warn({ err, issueKey: row.issueKey, ...where }, "could not bridge the closed pull request to the issue");
    }
  }
}
