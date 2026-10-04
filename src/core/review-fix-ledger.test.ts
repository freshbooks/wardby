import { describe, expect, it, vi } from "vitest";
import type { CodeReviewHost, PullRequestOrigin } from "../providers/review-host/types.js";
import { fixRoundLedger, OPT_OUT_LABEL, STOPPED_LABEL } from "./review-fix-ledger.js";

const origin = (labels: string[]): PullRequestOrigin => ({
  headSha: "a".repeat(40),
  isFork: false,
  state: "open",
  labels,
});

describe("label fix-round ledger", () => {
  it("is unavailable on a host without labels", () => {
    expect(fixRoundLedger({} as CodeReviewHost)).toBeNull();
  });

  it("counts round labels only, and sees the opt-out", () => {
    const ledger = fixRoundLedger({ addLabel: vi.fn() } as unknown as CodeReviewHost)!;
    const o = origin(["wardby-autofix-1", "wardby-autofix-2", STOPPED_LABEL, OPT_OUT_LABEL, "bug"]);
    expect(ledger.rounds(o)).toBe(2);
    expect(ledger.optedOut(o)).toBe(true);
    expect(ledger.optedOut(origin([]))).toBe(false);
  });

  it("records a round as its label", async () => {
    const addLabel = vi.fn(async () => undefined);
    await fixRoundLedger({ addLabel } as unknown as CodeReviewHost)!.recordRound("o/r", 7, 2);
    expect(addLabel).toHaveBeenCalledWith("o/r", 7, "wardby-autofix-2");
  });

  it("marks stopped once", async () => {
    const addLabel = vi.fn(async () => undefined);
    const ledger = fixRoundLedger({ addLabel } as unknown as CodeReviewHost)!;
    expect(await ledger.markStopped("o/r", 7, origin([]))).toBe(true);
    expect(addLabel).toHaveBeenCalledWith("o/r", 7, STOPPED_LABEL);
    expect(await ledger.markStopped("o/r", 7, origin([STOPPED_LABEL]))).toBe(false);
    expect(addLabel).toHaveBeenCalledTimes(1);
  });
});
