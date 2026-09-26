import { describe, expect, it, vi } from "vitest";
import type { CodeReviewHost } from "../providers/review-host/types.js";
import { closeOpenHostCheck } from "./review-host-checks.js";

function db(row: Record<string, unknown> | null, budget: unknown = null) {
  return {
    runHostCheck: {
      findUnique: vi.fn(async () => row),
      update: vi.fn(async () => row),
    },
    run: { findUnique: vi.fn(async () => budget) },
  } as never;
}

const host = () => ({ provider: "github", completeCheck: vi.fn(async () => undefined) }) as unknown as CodeReviewHost;

describe("closeOpenHostCheck", () => {
  it("completes an open check as a failure, so a required check blocks the merge, and records it", async () => {
    const h = host();
    const d = db({
      runId: "r1",
      provider: "github",
      repository: "o/n",
      checkId: "11",
      headSha: "a",
      completedAt: null,
    });
    await closeOpenHostCheck(d, { id: "r1", status: "failed" }, { github: h });
    expect(h.completeCheck).toHaveBeenCalledWith("o/n", {
      checkId: "11",
      conclusion: "failure",
      title: "Review did not complete",
      summary: 'wardby run r1 ended with status "failed" before publishing a review. Use Re-run to try again.',
    });
    expect((d as { runHostCheck: { update: ReturnType<typeof vi.fn> } }).runHostCheck.update).toHaveBeenCalledOnce();
  });

  it.each(["refused", "budget_exhausted"] as const)("says a %s review ran out of budget", async (status) => {
    const h = host();
    const d = db(
      { runId: "r1", provider: "github", repository: "o/n", checkId: "11", completedAt: null },
      { agent: { budgetUsd: 2, budgetGroup: null }, codingRun: null },
    );
    await closeOpenHostCheck(d, { id: "r1", status }, { github: h });
    const sentence =
      status === "refused"
        ? "Out of budget: this run could not start within its $2.00 budget."
        : "Out of budget: this run's $2.00 budget was used up.";
    expect(h.completeCheck).toHaveBeenCalledWith("o/n", {
      checkId: "11",
      conclusion: "failure",
      title: "Review could not run: out of budget",
      summary: `${sentence} Use Re-run after raising the budget or when it resets.`,
    });
  });

  it("does nothing for a completed check, no check, or no hosts, and never throws", async () => {
    const h = host();
    await closeOpenHostCheck(
      db({ runId: "r1", provider: "github", repository: "o/n", checkId: "11", completedAt: new Date() }),
      { id: "r1", status: "succeeded" },
      { github: h },
    );
    await closeOpenHostCheck(db(null), { id: "r1", status: "succeeded" }, { github: h });
    await closeOpenHostCheck(db(null), { id: "r1", status: "succeeded" }, undefined);
    expect(h.completeCheck).not.toHaveBeenCalled();

    vi.mocked(h.completeCheck).mockRejectedValueOnce(new Error("github_api_unavailable"));
    await expect(
      closeOpenHostCheck(
        db({ runId: "r1", provider: "github", repository: "o/n", checkId: "11", completedAt: null }),
        { id: "r1", status: "failed" },
        { github: h },
      ),
    ).resolves.toBeUndefined();
  });
});
