import { describe, expect, it } from "vitest";
import { summarizeCi } from "./ci.js";
import type { CiCheckView } from "./types.js";

const c = (status: CiCheckView["status"], conclusion: string | null): CiCheckView => ({
  name: "x",
  kind: "check_run",
  status,
  conclusion,
  app: null,
});

describe("summarizeCi", () => {
  it("is none without checks", () => expect(summarizeCi([])).toBe("none"));
  it("fails on any failed check, even while others run", () =>
    expect(summarizeCi([c("in_progress", null), c("completed", "timed_out")])).toBe("failing"));
  it("is pending while any check is unfinished", () =>
    expect(summarizeCi([c("completed", "success"), c("queued", null)])).toBe("pending"));
  it("passes when everything succeeded or was skipped/neutral", () =>
    expect(summarizeCi([c("completed", "success"), c("completed", "skipped"), c("completed", "neutral")])).toBe(
      "passing",
    ));
  it("is inconclusive for cancelled/stale or only skipped results", () => {
    expect(summarizeCi([c("completed", "success"), c("completed", "cancelled")])).toBe("inconclusive");
    expect(summarizeCi([c("completed", "skipped")])).toBe("inconclusive");
  });
});
