import { describe, expect, it, vi } from "vitest";
import type { RunStatus } from "#prisma";
import type { CodeReviewHost } from "../providers/review-host/types.js";
import {
  collectRunOutcome,
  completeHostStatus,
  mentionStatusRow,
  outcomeBody,
  postMentionStatus,
  workingBody,
} from "./host-status.js";

const REPO = "chfields/knock-knock-jokes";

function host(): CodeReviewHost & { comment: ReturnType<typeof vi.fn>; editComment: ReturnType<typeof vi.fn> } {
  return {
    provider: "github",
    repositoryPermission: vi.fn(),
    readPullRequest: vi.fn(),
    pullRequestHead: vi.fn(),
    readFile: vi.fn(),
    listFiles: vi.fn(),
    publishReview: vi.fn(),
    comment: vi.fn(async () => ({ url: "https://x/c", id: "501" })),
    editComment: vi.fn(async () => undefined),
    acknowledge: vi.fn(),
    startCheck: vi.fn(),
    completeCheck: vi.fn(),
  };
}

type StatusRow = {
  runId: string;
  provider: string;
  repository: string;
  number: number;
  commentKind: string;
  commentId: string | null;
  replyToReviewCommentId: string | null;
  completedAt: Date | null;
};

function db(opts: { row?: StatusRow | null; children?: unknown[]; run?: unknown; claimed?: number } = {}) {
  return {
    runHostStatus: {
      findUnique: vi.fn(async () => opts.row ?? null),
      update: vi.fn(async () => undefined),
      updateMany: vi.fn(async () => ({ count: opts.claimed ?? 1 })),
    },
    run: {
      findMany: vi.fn(async () => opts.children ?? []),
      findUnique: vi.fn(async () => opts.run ?? null),
    },
  };
}

const row = (over: Partial<StatusRow> = {}): StatusRow => ({
  runId: "r1",
  provider: "github",
  repository: REPO,
  number: 71,
  commentKind: "conversation",
  commentId: "501",
  replyToReviewCommentId: null,
  completedAt: null,
  ...over,
});

const child = (result: unknown, status = "succeeded", id = "c1") => ({ id, status, codingRun: { result } });

describe("mentionStatusRow", () => {
  it("records where to comment, replying in the thread for an inline mention", () => {
    expect(mentionStatusRow("github", { repository: REPO, number: 7 }, "r1")).toEqual({
      runId: "r1",
      provider: "github",
      repository: REPO,
      number: 7,
      commentKind: "conversation",
      replyToReviewCommentId: null,
    });
    expect(
      mentionStatusRow("github", { repository: REPO, number: 7, replyToReviewCommentId: "88" }, "r1"),
    ).toMatchObject({ commentKind: "inline", replyToReviewCommentId: "88" });
  });
});

describe("outcomeBody", () => {
  const run = (status: RunStatus, finalText: string | null = null) => ({ id: "r1", status, finalText });

  it("uses a custom no-pull-request sentence when given", () => {
    const body = outcomeBody(run("succeeded", "hi"), REPO, [], [], { noPullRequestText: "Done." });
    expect(body).toMatch(/^✅ Done\.\n\n> hi/);
  });
  it("shows the reply itself, capped, when it is the answer", () => {
    expect(outcomeBody(run("succeeded", "Filed it."), REPO, [], [], { replyAsAnswer: true })).toMatch(
      /^✅ Filed it\.\n\n/,
    );
    const long = outcomeBody(run("succeeded", "x".repeat(2500)), REPO, [], [], { replyAsAnswer: true });
    expect(long).toContain(`✅ ${"x".repeat(2000)}…`);
    expect(
      outcomeBody(run("succeeded", null), REPO, [], [], { replyAsAnswer: true, noPullRequestText: "Done." }),
    ).toMatch(/^✅ Done\./);
  });
  it("links the pull requests a coding sub-run opened or updated", () => {
    const body = outcomeBody(run("succeeded"), REPO, [
      { outcome: "pull_request_opened", repository: REPO, pullRequestNumber: 73, codeProvider: "github" },
      { outcome: "pull_request_updated", repository: REPO, pullRequestNumber: 68, codeProvider: "github" },
      { outcome: "pull_request_opened", repository: "other/repo", pullRequestNumber: 5, codeProvider: "github" },
    ]);
    expect(body).toContain("✅ Opened #73");
    expect(body).toContain("Pushed changes to #68");
    expect(body).toContain("Opened other/repo#5");
    expect(body).toContain("`r1`");
  });

  it("flags a pull request whose run had failing checks instead of a plain ✅", () => {
    const body = outcomeBody(run("succeeded"), REPO, [
      {
        outcome: "pull_request_opened",
        repository: REPO,
        pullRequestNumber: 3,
        codeProvider: "github",
        failedChecks: 2,
      },
    ]);
    expect(body).toMatch(/^⚠️ Opened #3, but 2 checks failed in the run/);
    expect(body).not.toContain("✅");
  });

  it("shows the agent's reply, quoted and without live @-mentions, when no pull request came out", () => {
    const body = outcomeBody(run("succeeded", "Which file?\n@chfields please say"), REPO, []);
    expect(body).toMatch(/^✅ Finished without opening a pull request\./);
    expect(body).toContain("> Which file?\n> @​chfields please say");
  });

  it("truncates a long reply", () => {
    const body = outcomeBody(run("succeeded", "x".repeat(5000)), REPO, []);
    expect(body.length).toBeLessThan(2500);
    expect(body).toContain("…");
  });

  it("reports a failed sub-run as a failure even though the agent itself succeeded", () => {
    const body = outcomeBody(
      run("succeeded", "FAILED: delegate_to_build — status: failed"),
      REPO,
      [],
      [{ id: "c9", status: "failed" }],
    );
    expect(body).toMatch(/^❌ A sub-run did not succeed: `c9` \(`failed`\)\./);
    expect(body).toContain("> FAILED: delegate_to_build");
    expect(body).not.toContain("✅");
  });

  it("tells the requester to retry a run that was lost", () => {
    const body = outcomeBody(run("lost"), REPO, []);
    expect(body).toMatch(/^❌ Interrupted before it finished .*Repeat your request to retry\./);
  });

  it("reports a run that ran out of budget, or could not start for lack of it, with the budget sentence", () => {
    const sentence = "Out of budget: this run's $3.00 budget was used up.";
    const body = outcomeBody(run("budget_exhausted", "internal detail"), REPO, [], [], { budgetSentence: sentence });
    expect(body).toBe(`❌ ${sentence}\n\n<sub>wardby run \`r1\`</sub>`);
    const refused = outcomeBody(run("refused"), REPO, [], [], {
      budgetSentence: "Out of budget: this run could not start within its $1.00 budget.",
    });
    expect(refused).toMatch(/^❌ Out of budget: this run could not start/);
    // Without numbers it still says why.
    expect(outcomeBody(run("budget_exhausted"), REPO, [])).toMatch(/^❌ Out of budget\./);
  });

  it("says a sub-run ran out of budget", () => {
    const body = outcomeBody(run("succeeded", "done"), REPO, [], [{ id: "c9", status: "budget_exhausted" }]);
    expect(body).toMatch(/^❌ A sub-run ran out of budget: `c9`\./);
    const mixed = outcomeBody(
      run("succeeded"),
      REPO,
      [],
      [
        { id: "c9", status: "budget_exhausted" },
        { id: "c10", status: "failed" },
      ],
    );
    expect(mixed).toMatch(/^❌ A sub-run ran out of budget: `c9`\. A sub-run did not succeed: `c10` \(`failed`\)\./);
  });

  it("says a sub-run could not reach the model, naming the class of provider failure but not its code", () => {
    const quota = outcomeBody(
      run("succeeded", "done"),
      REPO,
      [],
      [{ id: "c9", status: "failed", failureCategory: "provider_quota" }],
    );
    expect(quota).toMatch(
      /^❌ A sub-run could not reach the model: The model provider refused the request: its account has reached a spending or quota limit\. An operator needs to raise the limit with the provider, then retry\./,
    );
    expect(quota).not.toContain("did not succeed");
    const mixed = outcomeBody(
      run("succeeded"),
      REPO,
      [],
      [
        { id: "c9", status: "failed", failureCategory: "provider_rate_limited" },
        { id: "c10", status: "failed", failureCategory: "provider_rate_limited" },
        { id: "c11", status: "failed", failureCategory: "job" },
      ],
    );
    expect(mixed).toMatch(
      /^❌ A sub-run could not reach the model: The model provider is rate-limiting requests\. Try again later\. A sub-run did not succeed: `c11` \(`failed`\)\./,
    );
    expect(mixed.match(/rate-limiting/g)).toHaveLength(1);
  });

  it("says a coding sub-run could not start because of its services, in the host sentence only", () => {
    const refused = outcomeBody(
      run("succeeded", "done"),
      REPO,
      [],
      [
        {
          id: "c9",
          status: "refused",
          error:
            "service_not_allowed: This repository asks for `redis`, which this agent isn't allowed to use. An admin or the agent's owner can allow it.",
        },
      ],
    );
    expect(refused).toMatch(
      /^❌ A sub-run could not start: This repository asks for `redis`, which this agent isn't allowed to use\. An admin or the agent's owner can allow it\./,
    );
    expect(refused).not.toContain("service_not_allowed");
    expect(refused).not.toContain("did not succeed");

    const unready = outcomeBody(
      run("succeeded"),
      REPO,
      [],
      [{ id: "c9", status: "failed", failureCategory: "service_unready", services: ["postgres"] }],
    );
    expect(unready).toMatch(
      /^❌ A sub-run could not start: The `postgres` service didn't become ready, so the run couldn't start\./,
    );
  });

  it("says a coding sub-run could not open its changes when it touched a protected path, without naming it, and doesn't double-count it", () => {
    const body = outcomeBody(
      run("succeeded"),
      REPO,
      [],
      [{ id: "c9", status: "failed", failureCategory: "protected_path" }],
    );
    expect(body).toBe(
      "❌ A sub-run could not open its changes: it changed a file its agent may not edit, so none of its changes were kept.\n\n<sub>wardby run `r1`</sub>",
    );
    expect(body).not.toContain("did not succeed");
  });

  it("still reports a sub-run refused for budget by its status", () => {
    const body = outcomeBody(
      run("succeeded"),
      REPO,
      [],
      [
        {
          id: "c9",
          status: "refused",
          error: "run_tree_exhausted: the run tree's shared budget is spent; the run was not started.",
        },
      ],
    );
    expect(body).toMatch(/A sub-run did not succeed: `c9` \(`refused`\)\./);
    expect(body).not.toContain("run_tree_exhausted");
  });

  it("reports any other unsuccessful run by its status, never its error text", () => {
    for (const status of ["failed", "cancelled"] as const) {
      const body = outcomeBody(run(status, "secret-ish internal detail"), REPO, []);
      expect(body).toMatch(/^❌ Stopped/);
      expect(body).toContain(`\`${status}\``);
      expect(body).not.toContain("secret-ish");
    }
  });

  it("still links a pull request a failed run managed to open", () => {
    const body = outcomeBody(run("failed"), REPO, [
      { outcome: "pull_request_opened", repository: REPO, pullRequestNumber: 80, codeProvider: "github" },
    ]);
    expect(body).toMatch(/^❌ /);
    expect(body).toContain("Opened #80");
  });
});

describe("postMentionStatus", () => {
  it("posts the working comment and records it on the dispatch-time row", async () => {
    const h = host();
    const d = db({ row: row({ commentId: null }), run: { id: "r1", status: "running", finalText: null } });
    await postMentionStatus(d as never, h, "r1", undefined);
    expect(h.comment).toHaveBeenCalledWith(REPO, { number: 71, body: workingBody("r1") });
    expect(d.runHostStatus.updateMany).toHaveBeenCalledWith({
      where: { runId: "r1", commentId: null, completedAt: null },
      data: { commentId: "501" },
    });
    expect(h.editComment).not.toHaveBeenCalled();
  });

  it("replies in the review thread for an inline mention", async () => {
    const h = host();
    const d = db({
      row: row({ commentId: null, commentKind: "inline", replyToReviewCommentId: "88" }),
      run: { id: "r1", status: "running", finalText: null },
    });
    await postMentionStatus(d as never, h, "r1", undefined);
    expect(h.comment).toHaveBeenCalledWith(REPO, { number: 71, body: workingBody("r1"), replyToReviewCommentId: "88" });
  });

  it("does nothing without a row, or when the comment exists or the row is complete", async () => {
    for (const r of [null, row(), row({ commentId: null, completedAt: new Date() })]) {
      const h = host();
      await postMentionStatus(db({ row: r }) as never, h, "r1", undefined);
      expect(h.comment).not.toHaveBeenCalled();
    }
  });

  it("completes the comment at once when the run already ended", async () => {
    const h = host();
    const d = db({ row: row({ commentId: null }), run: { id: "r1", status: "failed", finalText: null } });
    // After the claim, completeHostStatus reads the row with its new comment.
    d.runHostStatus.findUnique.mockResolvedValueOnce(row({ commentId: null })).mockResolvedValueOnce(row());
    await postMentionStatus(d as never, h, "r1", { github: h });
    expect(h.editComment).toHaveBeenCalledWith(REPO, expect.objectContaining({ id: "501", kind: "conversation" }));
  });

  it("stops when the reconciler completed the row meanwhile", async () => {
    const h = host();
    const d = db({ row: row({ commentId: null }), claimed: 0, run: { id: "r1", status: "failed", finalText: null } });
    await postMentionStatus(d as never, h, "r1", { github: h });
    expect(h.editComment).not.toHaveBeenCalled();
    expect(d.run.findUnique).not.toHaveBeenCalled();
  });

  it("never throws when the host refuses", async () => {
    const h = host();
    h.comment.mockRejectedValue(new Error("boom"));
    const d = db({ row: row({ commentId: null }) });
    await expect(postMentionStatus(d as never, h, "r1", undefined)).resolves.toBeUndefined();
    expect(d.runHostStatus.updateMany).not.toHaveBeenCalled();
  });
});

describe("completeHostStatus", () => {
  const finished = { id: "r1", status: "succeeded", finalText: "done" } as const;

  it("edits the comment with the outcome and marks it complete", async () => {
    const h = host();
    const d = db({
      row: row(),
      children: [
        child({ outcome: "pull_request_opened", repository: REPO, pullRequestNumber: 73, codeProvider: "github" }),
        child(null),
      ],
    });
    await completeHostStatus(d as never, finished, { github: h });
    expect(d.run.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { parentRunId: "r1" } }));
    expect(h.editComment).toHaveBeenCalledWith(REPO, {
      kind: "conversation",
      id: "501",
      body: expect.stringContaining("Opened #73"),
    });
    expect(d.runHostStatus.update).toHaveBeenCalledWith({
      where: { runId: "r1" },
      data: { commentId: "501", completedAt: expect.any(Date) },
    });
  });

  it("marks a failed sub-run as a failure", async () => {
    const h = host();
    const d = db({ row: row(), children: [child(null, "failed", "c9"), child(null, "running", "c10")] });
    await completeHostStatus(d as never, finished, { github: h });
    expect(h.editComment.mock.calls[0][1].body).toMatch(/^❌ A sub-run did not succeed: `c9` \(`failed`\)\./);
  });

  it("reads a failed sub-run's failure category to say the model provider refused it", async () => {
    const h = host();
    const d = db({
      row: row(),
      children: [{ id: "c9", status: "failed", codingRun: { result: null, failureCategory: "provider_unavailable" } }],
    });
    await completeHostStatus(d as never, finished, { github: h });
    expect(d.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          codingRun: { select: expect.objectContaining({ result: true, failureCategory: true }) },
        }),
      }),
    );
    expect(h.editComment.mock.calls[0][1].body).toMatch(
      /^❌ A sub-run could not reach the model: The model provider reported an outage or overload\. Try again later\./,
    );
  });

  it("reads each child's error and services, so a service refusal can be named", async () => {
    const d = db({
      row: row(),
      children: [
        {
          id: "c1",
          status: "failed",
          error: "coding_failure_service_unready:coding_diag_1",
          codingRun: {
            result: null,
            failureCategory: "service_unready",
            services: [{ name: "postgres", version: "16" }],
          },
        },
      ],
    });
    const h = host();
    await completeHostStatus(d as never, { id: "r1", status: "succeeded", finalText: "done" }, { github: h });
    expect(d.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          error: true,
          codingRun: { select: expect.objectContaining({ failureCategory: true, services: true }) },
        }),
      }),
    );
    expect(h.editComment.mock.calls[0][1].body).toMatch(/The `postgres` service didn't become ready/);
  });

  it("reports a run that ran out of budget with its amounts", async () => {
    const h = host();
    const d = db({
      row: row(),
      run: { agent: { budgetUsd: 3, budgetGroup: { name: "reviewers" } }, codingRun: { budgetReservedUsd: 0.52 } },
    });
    await completeHostStatus(d as never, { id: "r1", status: "budget_exhausted", finalText: null }, { github: h });
    expect(h.editComment.mock.calls[0][1].body).toMatch(
      /^❌ Out of budget: this run's \$0\.52 budget was used up \(the "reviewers" budget group had only that much left of its limit\)\./,
    );
  });

  it("leaves a row without a comment to the follow-up, unless asked to post", async () => {
    const h = host();
    const d = db({ row: row({ commentId: null }) });
    await completeHostStatus(d as never, { id: "r1", status: "lost", finalText: null }, { github: h });
    expect(h.comment).not.toHaveBeenCalled();
    expect(d.runHostStatus.update).not.toHaveBeenCalled();

    await completeHostStatus(
      d as never,
      { id: "r1", status: "lost", finalText: null },
      { github: h },
      {
        postIfMissing: true,
      },
    );
    expect(h.comment).toHaveBeenCalledWith(REPO, {
      number: 71,
      body: expect.stringMatching(/^❌ Interrupted before it finished/),
    });
    expect(d.runHostStatus.update).toHaveBeenCalledWith({
      where: { runId: "r1" },
      data: { commentId: "501", completedAt: expect.any(Date) },
    });
  });

  it("posts a missing outcome as a reply in the review thread for an inline mention", async () => {
    const h = host();
    const d = db({ row: row({ commentId: null, commentKind: "inline", replyToReviewCommentId: "88" }) });
    await completeHostStatus(
      d as never,
      { id: "r1", status: "lost", finalText: null },
      { github: h },
      {
        postIfMissing: true,
      },
    );
    expect(h.comment).toHaveBeenCalledWith(REPO, expect.objectContaining({ replyToReviewCommentId: "88" }));
  });

  it("does nothing for a run without a status row, or one already completed", async () => {
    for (const r of [null, row({ completedAt: new Date() })]) {
      const h = host();
      const d = db({ row: r });
      await completeHostStatus(d as never, finished, { github: h }, { postIfMissing: true });
      expect(h.editComment).not.toHaveBeenCalled();
      expect(h.comment).not.toHaveBeenCalled();
      expect(d.runHostStatus.update).not.toHaveBeenCalled();
    }
  });

  it("ignores malformed coding results", async () => {
    const h = host();
    const d = db({
      row: row(),
      children: [child({ outcome: "pull_request_opened", pullRequestNumber: "73" }), child("junk")],
    });
    await completeHostStatus(d as never, finished, { github: h });
    expect(h.editComment.mock.calls[0][1].body).toMatch(/^✅ Finished without opening a pull request\./);
  });

  it("never throws when the edit fails, and leaves the row open for the reconciler", async () => {
    const h = host();
    h.editComment.mockRejectedValue(new Error("boom"));
    const d = db({ row: row() });
    await expect(completeHostStatus(d as never, finished, { github: h })).resolves.toBeUndefined();
    expect(d.runHostStatus.update).not.toHaveBeenCalled();
  });

  it("does nothing without hosts", async () => {
    const d = db({ row: row() });
    await completeHostStatus(d as never, finished, undefined);
    expect(d.runHostStatus.findUnique).not.toHaveBeenCalled();
  });
});

describe("collectRunOutcome", () => {
  it("returns opened PRs and failed children for a finished run", async () => {
    const database = {
      run: {
        findMany: vi.fn(async () => [
          {
            id: "c1",
            status: "succeeded",
            error: null,
            codingRun: {
              result: {
                outcome: "pull_request_opened",
                repository: "o/r",
                pullRequestNumber: 4,
                codeProvider: "github",
              },
              failureCategory: null,
              services: [],
            },
          },
          { id: "c2", status: "failed", error: null, codingRun: { result: null, failureCategory: "x", services: [] } },
        ]),
      },
    } as never;
    const out = await collectRunOutcome(database, { id: "r1", status: "succeeded", finalText: null });
    expect(out.pullRequests).toEqual([
      { outcome: "pull_request_opened", repository: "o/r", pullRequestNumber: 4, codeProvider: "github", runId: "c1" },
    ]);
    expect(out.failedChildren.map((c) => c.id)).toEqual(["c2"]);
    expect(out.budgetSentence).toBeUndefined();
  });

  it("counts a pull request's failed checks from the coding result", async () => {
    const database = {
      run: {
        findMany: vi.fn(async () => [
          {
            id: "c1",
            status: "succeeded",
            error: null,
            codingRun: {
              result: {
                outcome: "pull_request_opened",
                repository: "o/r",
                pullRequestNumber: 4,
                tests: [
                  { command: "npm run typecheck", outcome: "failed" },
                  { command: "npm run build", outcome: "failed" },
                  { command: "npm run e2e", outcome: "skipped" },
                ],
              },
              failureCategory: null,
              services: [],
            },
          },
        ]),
      },
    } as never;
    const out = await collectRunOutcome(database, { id: "r1", status: "succeeded", finalText: null });
    expect(out.pullRequests[0]!.failedChecks).toBe(2);
  });
});
