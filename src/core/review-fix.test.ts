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
import { capBody, startReviewFixRound, reviewFixTaskText, type ReviewFixDeps } from "./review-fix.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const REPO = "o/r";
const REQ = { provider: "github" as const, repository: REPO, prNumber: 7, headSha: SHA, reviewBody: "needs work" };

function setup(opts: { origin?: Partial<PullRequestOrigin>; link?: object | null; authorized?: boolean } = {}) {
  vi.mocked(dispatchRun).mockClear();
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
    addLabel: vi.fn(async () => undefined),
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
  const deps = {
    db: { agentRepository: { findFirst: vi.fn(async () => link) } } as never,
    executor: {} as never,
    hosts: { github: host },
    repoAccess,
  } as ReviewFixDeps;
  return { deps, host };
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
});
