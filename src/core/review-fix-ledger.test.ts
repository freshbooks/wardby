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

  it("records the first round when the PR has none yet", async () => {
    const addLabel = vi.fn(async () => undefined);
    await fixRoundLedger({ addLabel } as unknown as CodeReviewHost)!.recordRound("o/r", 7, origin([]));
    expect(addLabel).toHaveBeenCalledWith("o/r", 7, "wardby-autofix-1");
  });

  it("records one past the highest existing round label, never reusing one already there", async () => {
    const addLabel = vi.fn(async () => undefined);
    // Only "wardby-autofix-2" is on the PR (a gap: round 1's label was removed, say), so the
    // round *count* is 1, but the next label must still be 3, not 2 (which addLabel would treat
    // as a no-op) and not 2 derived from count+1 either.
    await fixRoundLedger({ addLabel } as unknown as CodeReviewHost)!.recordRound(
      "o/r",
      7,
      origin(["wardby-autofix-2"]),
    );
    expect(addLabel).toHaveBeenCalledWith("o/r", 7, "wardby-autofix-3");
  });

  it("marks stopped once", async () => {
    const addLabel = vi.fn(async () => undefined);
    const ledger = fixRoundLedger({ addLabel } as unknown as CodeReviewHost)!;
    expect(await ledger.markStopped("o/r", 7, origin([]))).toBe(true);
    expect(addLabel).toHaveBeenCalledWith("o/r", 7, STOPPED_LABEL);
    expect(await ledger.markStopped("o/r", 7, origin([STOPPED_LABEL]))).toBe(false);
    expect(addLabel).toHaveBeenCalledTimes(1);
  });

  describe("matches labels case-insensitively, as GitHub does", () => {
    it("counts mixed-case round labels and sees a mixed-case opt-out", () => {
      const ledger = fixRoundLedger({ addLabel: vi.fn() } as unknown as CodeReviewHost)!;
      const o = origin(["Wardby-Autofix-1", "WARDBY-AUTOFIX-2", "Wardby-Autofix-Off"]);
      expect(ledger.rounds(o)).toBe(2);
      expect(ledger.optedOut(o)).toBe(true);
    });

    it("numbers the next round past the highest mixed-case label", async () => {
      const addLabel = vi.fn(async () => undefined);
      await fixRoundLedger({ addLabel } as unknown as CodeReviewHost)!.recordRound(
        "o/r",
        7,
        origin(["wardby-autofix-1", "Wardby-Autofix-4"]),
      );
      expect(addLabel).toHaveBeenCalledWith("o/r", 7, "wardby-autofix-5");
    });

    it("sees a mixed-case stopped label, so it is not added again", async () => {
      const addLabel = vi.fn(async () => undefined);
      const ledger = fixRoundLedger({ addLabel } as unknown as CodeReviewHost)!;
      expect(await ledger.markStopped("o/r", 7, origin(["Wardby-AutoFix-Limit"]))).toBe(false);
      expect(addLabel).not.toHaveBeenCalled();
    });
  });
});
