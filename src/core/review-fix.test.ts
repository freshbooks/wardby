import { describe, expect, it, vi } from "vitest";
import type { CodeReviewHost, PullRequestOrigin } from "../providers/review-host/types.js";
import type { RepoAccessGate } from "./repo-access.js";

const { txStub } = vi.hoisted(() => ({ txStub: { runHostStatus: { create: vi.fn(async () => undefined) } } }));
vi.mock("./dispatch.js", () => ({
  dispatchRun: vi.fn(async (opts: { agentId: string; afterPersist?: (tx: unknown, run: unknown) => Promise<void> }) => {
    const run = { id: `run-${opts.agentId}` };
    await opts.afterPersist?.(txStub, run);
    return { run };
  }),
  checkContinuation: vi.fn(async () => ({
    ok: true,
    root: { runId: "run_1", baseRef: "main", headRef: "wardby/run-run_1", pullRequestNumber: 7 },
  })),
}));
vi.mock("./host-status.js", async (orig) => ({
  ...(await orig<typeof import("./host-status.js")>()),
  postMentionStatus: vi.fn(async () => undefined),
}));
import { checkContinuation, dispatchRun } from "./dispatch.js";
import { postMentionStatus } from "./host-status.js";
import {
  capBody,
  reviewFixTaskText,
  startReviewFixAfterReview,
  startReviewFixRound,
  type ReviewFixDeps,
} from "./review-fix.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const REPO = "o/r";
const REQ = { provider: "github" as const, repository: REPO, prNumber: 7, headSha: SHA, reviewBody: "needs work" };

function setup(
  opts: {
    origin?: Partial<PullRequestOrigin>;
    link?: object | null;
    authorized?: boolean;
    check?: object | null;
  } = {},
) {
  vi.mocked(dispatchRun).mockClear();
  const addLabel = vi.fn(async () => undefined);
  const host = {
    provider: "github",
    pullRequestOrigin: vi.fn(async () => ({
      headSha: SHA,
      isFork: false,
      state: "open",
      labels: [],
      markerRunId: "run_1",
      ...opts.origin,
    })),
    addLabel,
    comment: vi.fn(async () => ({ url: "u", id: "1" })),
  } as unknown as CodeReviewHost;
  const link =
    opts.link === null
      ? null
      : {
          agentId: "delivery",
          authorizedVia: "host_permission",
          reviewFixMaxRounds: null,
          agent: { ownerId: "p1" },
          ...opts.link,
        };
  const repoAccess = {
    authorizeUse: vi.fn(async () =>
      opts.authorized === false ? { ok: false, reason: "not_authorized" } : { ok: true },
    ),
  } as unknown as RepoAccessGate;
  const check = opts.check === undefined ? null : opts.check;
  const findUniqueCheck = vi.fn(async () => check);
  const deps = {
    db: {
      agentRepository: { findFirst: vi.fn(async () => link) },
      runHostCheck: { findUnique: findUniqueCheck },
    } as never,
    executor: {} as never,
    hosts: { github: host },
    repoAccess,
  } as ReviewFixDeps;
  return { deps, host, addLabel, findUniqueCheck };
}

describe("startReviewFixRound", () => {
  it("dispatches round 1 on the delivery agent, labels it, and posts a status comment", async () => {
    const { deps, host } = setup();
    const result = await startReviewFixRound(REQ, deps);
    expect(result).toEqual({ kind: "dispatched", runId: "run-delivery", round: 1, maxRounds: 2 });
    const opts = vi.mocked(dispatchRun).mock.calls[0][0];
    expect(opts).toMatchObject({ agentId: "delivery", trigger: "host_event" });
    expect(opts.taskOverride).toContain('pass continuePriorRun set to exactly "run_1"');
    expect(opts.taskOverride).toContain("Automatic fix round 1 of 2 for PR #7");
    expect(txStub.runHostStatus.create).toHaveBeenCalled();
    expect(host.addLabel).toHaveBeenCalledWith(REPO, 7, "wardby-autofix-1");
    expect(postMentionStatus).toHaveBeenCalledWith(
      deps.db,
      host,
      "run-delivery",
      deps.hosts,
      "🔁 Fix round 1 of 2: working on it.",
    );
  });

  it("uses the link's cap", async () => {
    const { deps } = setup({
      link: { reviewFixMaxRounds: 3 },
      origin: { labels: ["wardby-autofix-1", "wardby-autofix-2"] },
    });
    expect(await startReviewFixRound(REQ, deps)).toMatchObject({ kind: "dispatched", round: 3, maxRounds: 3 });
  });

  it.each([
    ["no_link", { link: null }],
    ["not_authorized", { authorized: false }],
    ["not_current", { origin: { headSha: "f".repeat(40) } }],
    ["not_current", { origin: { state: "closed" } }],
    ["not_current", { origin: { isFork: true } }],
    ["not_wardby_pr", { origin: { markerRunId: undefined } }],
    ["opted_out", { origin: { labels: ["wardby-autofix-off"] } }],
  ] as const)("skips silently: %s", async (reason, opts) => {
    const { deps, host } = setup(opts as never);
    expect(await startReviewFixRound(REQ, deps)).toEqual({ kind: "skipped", reason });
    expect(dispatchRun).not.toHaveBeenCalled();
    expect(host.comment).not.toHaveBeenCalled();
  });

  it("refuses once, with a comment, when this deployment can't continue the PR", async () => {
    vi.mocked(checkContinuation).mockResolvedValueOnce({ ok: false, reason: "unknown_run" });
    const { deps, host } = setup();
    expect(await startReviewFixRound(REQ, deps)).toEqual({ kind: "skipped", reason: "cannot_continue" });
    expect(host.addLabel).toHaveBeenCalledWith(REPO, 7, "wardby-autofix-limit");
    expect(host.comment).toHaveBeenCalledWith(REPO, { number: 7, body: expect.stringContaining("`run_1`") });
  });

  it("refuses a known run that opened a different PR", async () => {
    vi.mocked(checkContinuation).mockResolvedValueOnce({
      ok: true,
      root: { runId: "run_1", baseRef: "main", headRef: "h", pullRequestNumber: 9 },
    });
    const { deps } = setup();
    expect(await startReviewFixRound(REQ, deps)).toEqual({ kind: "skipped", reason: "cannot_continue" });
  });

  it("stops at the cap with one comment, and stays quiet once stopped", async () => {
    const { deps, host } = setup({ origin: { labels: ["wardby-autofix-1", "wardby-autofix-2"] } });
    expect(await startReviewFixRound(REQ, deps)).toEqual({ kind: "skipped", reason: "capped" });
    expect(host.comment).toHaveBeenCalledWith(REPO, { number: 7, body: capBody(2) });

    const again = setup({ origin: { labels: ["wardby-autofix-1", "wardby-autofix-2", "wardby-autofix-limit"] } });
    expect(await startReviewFixRound(REQ, again.deps)).toEqual({ kind: "skipped", reason: "capped" });
    expect(again.host.comment).not.toHaveBeenCalled();
  });

  it("caps the review text in the task", () => {
    const task = reviewFixTaskText({
      repository: REPO,
      prNumber: 7,
      headSha: SHA,
      round: 1,
      maxRounds: 2,
      priorRunId: "run_1",
      reviewBody: "x".repeat(30_000),
    });
    expect(task.length).toBeLessThan(21_500);
  });

  it("does not dispatch when recording the round fails", async () => {
    const { deps, addLabel } = setup();
    addLabel.mockRejectedValueOnce(new Error("label failed"));
    expect(await startReviewFixRound(REQ, deps)).toEqual({ kind: "skipped", reason: "dispatch_declined" });
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it("keeps the round counted even when the dispatch that follows is declined", async () => {
    const { deps, addLabel } = setup();
    vi.mocked(dispatchRun).mockResolvedValueOnce(null);
    expect(await startReviewFixRound(REQ, deps)).toEqual({ kind: "skipped", reason: "dispatch_declined" });
    expect(addLabel).toHaveBeenCalledWith(REPO, 7, "wardby-autofix-1");
  });
});

describe("startReviewFixAfterReview", () => {
  const CHECK = {
    verdict: "CHANGES_REQUESTED",
    provider: "github",
    repository: REPO,
    prNumber: 7,
    headSha: SHA,
    reviewBody: "needs work",
  };

  it("starts a round when the run's own check requested changes", async () => {
    const { deps } = setup({ check: CHECK });
    await startReviewFixAfterReview("run-1", deps);
    expect(dispatchRun).toHaveBeenCalled();
  });

  it.each([
    ["an approval", { ...CHECK, verdict: "APPROVE" }],
    ["no verdict yet", { ...CHECK, verdict: null }],
  ] as const)("does not start a round for %s", async (_label, check) => {
    const { deps } = setup({ check });
    await startReviewFixAfterReview("run-1", deps);
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it("does not start a round for a non-github provider", async () => {
    const { deps } = setup({ check: { ...CHECK, provider: "bitbucket" } });
    await startReviewFixAfterReview("run-1", deps);
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it("never throws when the check lookup fails", async () => {
    const { deps, findUniqueCheck } = setup();
    findUniqueCheck.mockRejectedValueOnce(new Error("db down"));
    await expect(startReviewFixAfterReview("run-1", deps)).resolves.toBeUndefined();
  });
});
