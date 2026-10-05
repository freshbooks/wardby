import { describe, expect, it } from "vitest";
import { CONTINUATION_CLOSED_CATEGORY, isContinuationClosedError } from "./continuation-wording.js";

describe("isContinuationClosedError", () => {
  it("recognises only the persisted continuation_closed failure", () => {
    expect(CONTINUATION_CLOSED_CATEGORY).toBe("continuation_closed");
    expect(isContinuationClosedError("coding_failure_continuation_closed:coding_diag_1")).toBe(true);
    expect(isContinuationClosedError("coding_failure_workspace:coding_diag_1")).toBe(false);
    expect(isContinuationClosedError(null)).toBe(false);
  });
});
