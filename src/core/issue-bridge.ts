/**
 * Links a run's pull requests to the issue that started it: records each
 * issue/PR pair, puts a web link on the issue, and applies the link's
 * configured status move. Provider-neutral: a code host is only ever
 * { provider, repository, number }. The issue key comes from the run tree
 * (RunIssueStatus), never from model output. The status move is a control-plane
 * action (not gated by allowedTransitions). Nothing here throws.
 */
import type { PrismaClient } from "#prisma";
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

/** Returns sentences for the outcome comment (a refused status move); empty when there is nothing to say. */
export async function recordPullRequests(
  db: IssueBridgeDb,
  tracker: IssueTracker,
  input: RecordPullRequestsInput,
): Promise<{ notes: string[] }> {
  const notes: string[] = [];
  try {
    for (const pr of input.pullRequests) {
      try {
        await db.issuePullRequest.upsert({
          where: {
            codeProvider_repository_number_issueProvider_issueKey: {
              codeProvider: pr.codeProvider,
              repository: pr.repository,
              number: pr.number,
              issueProvider: input.issueProvider,
              issueKey: input.issueKey,
            },
          },
          create: {
            issueProvider: input.issueProvider,
            issueKey: input.issueKey,
            codeProvider: pr.codeProvider,
            repository: pr.repository,
            number: pr.number,
            url: pr.url,
            agentId: input.agentId,
            openedByRunId: pr.openedByRunId,
          },
          update: { url: pr.url },
        });
      } catch (err) {
        log.warn(
          { err, issueKey: input.issueKey, repository: pr.repository, number: pr.number },
          "could not record the issue/PR pair",
        );
      }
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
    if (target && input.pullRequests.some((pr) => pr.outcome === "pull_request_opened")) {
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
 * or concurrent delivery finds nothing to do. Never throws.
 */
export async function handlePullRequestClosed(
  db: PullRequestClosedDb,
  trackers: IssueTrackerRegistry | undefined,
  pr: ClosedPullRequest,
): Promise<void> {
  if (!trackers) return;
  const where = { codeProvider: pr.codeProvider, repository: pr.repository, number: pr.number };
  let rows: Awaited<ReturnType<PullRequestClosedDb["issuePullRequest"]["findMany"]>>;
  try {
    rows = await db.issuePullRequest.findMany({ where: { ...where, state: "open" } });
  } catch (err) {
    log.warn({ err, ...where }, "could not look up the issues linked to a closed pull request");
    return;
  }
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
