import { describe, expect, it, vi } from "vitest";
import {
  collectRelatedPullRequests,
  updateRelatedPullRequests,
  type RelatedPullRequestsDb,
} from "./related-pull-requests.js";
import type { CodeReviewHost } from "../providers/review-host/types.js";

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

function host(origins: Record<string, { state: string; merged?: boolean; draft?: boolean; markerRunId?: string }>) {
  return {
    provider: "github",
    pullRequestOrigin: vi.fn(async (repository: string, n: number) => {
      const o = origins[`${repository}#${n}`];
      if (!o) throw new Error("github_api_error:404");
      return { headSha: "a".repeat(40), isFork: false, labels: [], ...o };
    }),
    replaceRelatedSection: vi.fn(async () => "updated" as const),
  } as unknown as CodeReviewHost & {
    pullRequestOrigin: ReturnType<typeof vi.fn>;
    replaceRelatedSection: ReturnType<typeof vi.fn>;
  };
}

/** `passes`: the collector's $queryRaw answers in order (a second pass only for a continuation). */
function finalizerDb(passes: Row[][], recorded: Record<string, string>) {
  const { db: base } = db(passes);
  return Object.assign(base, {
    run: { findFirst: vi.fn(async () => ({ id: "child" })) },
    codingRun: {
      findUnique: vi.fn(async ({ where }: { where: { runId: string } }) =>
        recorded[where.runId] ? { repository: recorded[where.runId] } : null,
      ),
    },
  }) as unknown as RelatedPullRequestsDb;
}

describe("updateRelatedPullRequests", () => {
  const rows = [
    row("c1", opened("acme/order-service", 2), 1),
    row("c2", opened("acme/bff", 3), 2),
    row("c3", opened("acme/app", 4), 3),
  ];
  const recorded = { c1: "acme/order-service", c2: "acme/bff", c3: "acme/app" };
  const trackers = { jira: { issueUrl: (k: string) => `https://example.atlassian.net/browse/${k}` } } as never;

  it("rewrites every open App-authored PR with live states, marking itself, and leaves merged ones alone", async () => {
    const h = host({
      "acme/order-service#2": { state: "closed", merged: true, markerRunId: "c1" },
      "acme/bff#3": { state: "open", draft: true, markerRunId: "c2" },
      "acme/app#4": { state: "open", markerRunId: "c3" },
    });
    await updateRelatedPullRequests(finalizerDb([rows], recorded), { id: "lead" }, { github: h }, trackers);
    expect(h.replaceRelatedSection).toHaveBeenCalledTimes(2);
    const [repo, n, input] = h.replaceRelatedSection.mock.calls[1];
    expect([repo, n, input.expectedMarkerRunId]).toEqual(["acme/app", 4, "c3"]);
    expect(input.block).toContain("1. [acme/bff#3](https://github.com/acme/bff/pull/3) — draft");
    expect(input.block).toContain("2. **This pull request** — open");
    expect(input.block).toContain("- [acme/order-service#2](https://github.com/acme/order-service/pull/2) — merged");
    expect(input.block).toContain("[PROJ-13](https://example.atlassian.net/browse/PROJ-13)");
  });

  it("never edits a PR whose marker run this deployment did not record for that repository", async () => {
    const h = host({
      "acme/order-service#2": { state: "open", markerRunId: "c1" },
      "acme/bff#3": { state: "open", markerRunId: "someone-else" },
      "acme/app#4": { state: "open" },
    });
    await updateRelatedPullRequests(finalizerDb([rows], recorded), { id: "lead" }, { github: h }, undefined);
    expect(h.replaceRelatedSection.mock.calls.map((c) => c[0])).toEqual(["acme/order-service"]);
  });

  it("does nothing for a set of one, a run without children, or without a capable host — and never throws", async () => {
    const h = host({ "acme/app#4": { state: "open", markerRunId: "c3" } });
    await updateRelatedPullRequests(finalizerDb([[rows[2]]], recorded), { id: "lead" }, { github: h }, undefined);
    const childless = finalizerDb([rows], recorded);
    (childless.run.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await updateRelatedPullRequests(childless, { id: "lead" }, { github: h }, undefined);
    await updateRelatedPullRequests(finalizerDb([rows], recorded), { id: "lead" }, undefined, undefined);
    expect(h.replaceRelatedSection).not.toHaveBeenCalled();
    const broken = finalizerDb([rows], recorded);
    (broken.$queryRaw as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    await expect(updateRelatedPullRequests(broken, { id: "lead" }, { github: h }, undefined)).resolves.toBeUndefined();
  });

  it("keeps going when one PR can't be read or written", async () => {
    const h = host({
      "acme/bff#3": { state: "open", markerRunId: "c2" },
      "acme/app#4": { state: "open", markerRunId: "c3" },
    });
    h.replaceRelatedSection.mockRejectedValueOnce(new Error("github_api_error:500"));
    await updateRelatedPullRequests(finalizerDb([rows], recorded), { id: "lead" }, { github: h }, undefined);
    expect(h.replaceRelatedSection).toHaveBeenCalledTimes(2);
    // order-service#2 couldn't be read: listed without a state, never written
    expect(h.replaceRelatedSection.mock.calls[1][2].block).toContain(
      "1. [acme/order-service#2](https://github.com/acme/order-service/pull/2)\n",
    );
  });

  // Decision 4c: a follow-up run (a mention or a fix round on app#4) whose coding child pushed to a
  // sibling refreshes the whole set, through the continuation's second pass.
  it("refreshes every open PR of the original request when a follow-up run pushed to a sibling", async () => {
    const h = host({
      "acme/order-service#2": { state: "open", markerRunId: "c1" },
      "acme/bff#3": { state: "open", markerRunId: "c2" },
      "acme/app#4": { state: "open", markerRunId: "c3" },
    });
    const followUp = [
      row("f1", { ...opened("acme/bff", 3), outcome: "pull_request_updated" }, 50, { rootCodingRunId: "c2" }),
    ];
    await updateRelatedPullRequests(
      finalizerDb([followUp, rows], recorded),
      { id: "mention-run" },
      { github: h },
      undefined,
    );
    expect(h.replaceRelatedSection.mock.calls.map((c) => `${c[0]}#${c[1]}`)).toEqual([
      "acme/order-service#2",
      "acme/bff#3",
      "acme/app#4",
    ]);
    expect(h.replaceRelatedSection.mock.calls[2][2].block).toContain(
      "1. [acme/order-service#2](https://github.com/acme/order-service/pull/2) — open\n2. [acme/bff#3](https://github.com/acme/bff/pull/3) — open\n3. **This pull request** — open",
    );
  });

  it("falls back to the stored state when a PR can't be read live", async () => {
    const h = host({ "acme/app#4": { state: "open", markerRunId: "c3" } });
    const { db: base } = db(
      [[rows[2]]],
      [{ repository: "acme/bff", number: 3, createdAt: at(0), openedByRunId: "old", state: "merged" }],
    );
    const fake = Object.assign(base, {
      run: { findFirst: vi.fn(async () => ({ id: "child" })) },
      codingRun: { findUnique: vi.fn(async () => ({ repository: "acme/app" })) },
    }) as unknown as RelatedPullRequestsDb;
    await updateRelatedPullRequests(fake, { id: "lead" }, { github: h }, undefined);
    expect(h.replaceRelatedSection.mock.calls[0][2].block).toContain(
      "- [acme/bff#3](https://github.com/acme/bff/pull/3) — merged",
    );
  });
});
