/**
 * Links a run's pull requests to the issue that started it: records each
 * issue/PR pair, puts a web link on the issue, and applies the link's
 * configured status move. Provider-neutral: a code host is only ever
 * { provider, repository, number }. The issue key comes from the run tree
 * (RunIssueStatus), never from model output. The status move is a control-plane
 * action (not gated by allowedTransitions). Nothing here throws.
 */
import type { PrismaClient } from "#prisma";
import type { IssueTracker } from "../providers/issue-tracker/types.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "issue-bridge" });

export type IssueBridgeDb = Pick<PrismaClient, "issuePullRequest">;

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
