import { describe, expect, it, vi } from "vitest";
import { collectRelatedPullRequests, type RelatedPullRequestsDb } from "./related-pull-requests.js";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 12, minute));
const opened = (repository: string, n: number) => ({
  outcome: "pull_request_opened",
  repository,
  pullRequestNumber: n,
  pullRequestUrl: `https://github.com/${repository}/pull/${n}`,
});

interface Row {
  runId: string;
  result: unknown;
  rootCodingRunId: string | null;
  issueProvider: string | null;
  issueKey: string | null;
  startedAt: Date;
}

/** $queryRaw answers per call from `passes`; issuePullRequest.findMany from `issueRows`. */
function db(passes: Row[][], issueRows: unknown[] = []) {
  const queryRaw = vi.fn(async () => passes.shift() ?? []);
  return {
    db: {
      $queryRaw: queryRaw,
      issuePullRequest: { findMany: vi.fn(async () => issueRows) },
    } as unknown as RelatedPullRequestsDb,
    queryRaw,
  };
}

const row = (runId: string, result: unknown, minute: number, extra: Partial<Row> = {}): Row => ({
  runId,
  result,
  rootCodingRunId: null,
  issueProvider: "jira",
  issueKey: "PROJ-13",
  startedAt: at(minute),
  ...extra,
});

describe("collectRelatedPullRequests", () => {
  it("lists the tree's opened pull requests in dispatch order, deduplicated, with the tree's issue", async () => {
    const { db: fake } = db([
      [
        row("c1", opened("acme/order-service", 2), 1),
        row("c2", opened("acme/notification-service", 2), 2),
        row("c3", { outcome: "no_changes" }, 3),
        row("c4", opened("acme/app", 4), 4),
      ],
    ]);
    const group = await collectRelatedPullRequests(fake, "parent");
    expect(group.pullRequests.map((p) => `${p.repository}#${p.number}`)).toEqual([
      "acme/order-service#2",
      "acme/notification-service#2",
      "acme/app#4",
    ]);
    expect(group.issue).toEqual({ provider: "jira", key: "PROJ-13" });
  });

  it("follows a continuation back to the original request's tree (second pass) so the set is not lost", async () => {
    const { db: fake, queryRaw } = db([
      [row("follow", { ...opened("acme/app", 4), outcome: "pull_request_updated" }, 30, { rootCodingRunId: "c4" })],
      [row("c1", opened("acme/order-service", 2), 1), row("c4", opened("acme/app", 4), 4)],
    ]);
    const group = await collectRelatedPullRequests(fake, "mention-run");
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(group.pullRequests.map((p) => `${p.repository}#${p.number}`)).toEqual([
      "acme/order-service#2",
      "acme/app#4",
    ]);
  });

  it("adds pull requests recorded for the same issue by other runs, ordered by when they were recorded", async () => {
    const { db: fake } = db(
      [[row("c4", opened("acme/app", 4), 40)]],
      [
        { repository: "acme/bff", number: 3, createdAt: at(10), openedByRunId: "old1", state: "merged" },
        { repository: "ACME/App", number: 4, createdAt: at(41), openedByRunId: "later", state: "open" },
        { repository: "acme/web", number: 9, createdAt: at(12), openedByRunId: "old2", state: "weird" },
      ],
    );
    const group = await collectRelatedPullRequests(fake, "parent");
    // Merged ones stay in the set; the tree's own opener wins over the issue row's; a stored state is kept.
    expect(group.pullRequests).toEqual([
      { repository: "acme/bff", number: 3, openedAt: at(10), openedByRunId: "old1", state: "merged" },
      { repository: "acme/web", number: 9, openedAt: at(12), openedByRunId: "old2" },
      { repository: "acme/app", number: 4, openedAt: at(40), openedByRunId: "c4", state: "open" },
    ]);
  });

  it("ignores malformed results and malformed issue keys, and skips the issue query without a key", async () => {
    const { db: fake } = db([
      [
        row("c1", { outcome: "pull_request_opened", repository: "acme/x", pullRequestNumber: -1 }, 1, {
          issueKey: "bad",
        }),
        row("c2", opened("not a repo", 2), 2, { issueKey: null }),
      ],
    ]);
    const group = await collectRelatedPullRequests(fake, "parent");
    expect(group).toEqual({ pullRequests: [] });
    expect(fake.issuePullRequest.findMany).not.toHaveBeenCalled();
  });
});
