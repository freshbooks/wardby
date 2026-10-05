import { describe, expect, it } from "vitest";
import { CONTINUATION_CLOSED_SENTENCE } from "../coding/continuation-wording.js";
import { codingChildResult } from "./runner.js";

const base = { finalText: null, costUsd: "0.25", tokensIn: 10, tokensOut: 5 };

describe("codingChildResult", () => {
  it("reports a finished coding sub-run's status, reply, and usage", () => {
    expect(
      JSON.parse(codingChildResult({ ...base, status: "succeeded", finalText: "Opened a PR.", error: null })),
    ).toEqual({
      status: "succeeded",
      finalText: "Opened a PR.",
      costUsd: 0.25,
      tokensIn: 10,
      tokensOut: 5,
    });
  });

  it("gives the router the host sentence of a service refusal, never the raw error", () => {
    const result = JSON.parse(
      codingChildResult({
        ...base,
        status: "refused",
        error: "service_unknown: This repository asks for `postgres 18`, which wardby's service catalog doesn't have.",
      }),
    );
    expect(result).toMatchObject({
      status: "refused",
      refusal: "This repository asks for `postgres 18`, which wardby's service catalog doesn't have.",
    });
    expect(JSON.stringify(result)).not.toContain("service_unknown");
  });

  it("adds nothing for any other refusal", () => {
    const result = JSON.parse(codingChildResult({ ...base, status: "refused", error: "run_tree_exhausted: spent" }));
    expect(result).not.toHaveProperty("refusal");
  });

  it("tells the parent a continuation found its PR no longer open, never the raw error", () => {
    const out = JSON.parse(
      codingChildResult({
        status: "failed",
        finalText: null,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        error: "coding_failure_continuation_closed:coding_diag_1",
      }),
    );
    expect(out.refusal).toBe(CONTINUATION_CLOSED_SENTENCE);
    expect(JSON.stringify(out)).not.toContain("coding_diag_1");
  });

  it('gives the same sentence when the PR closed before any spend, even though that sub-run is "refused"', () => {
    const out = JSON.parse(
      codingChildResult({
        status: "refused",
        finalText: null,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        error: "coding_failure_continuation_closed:coding_diag_2",
      }),
    );
    expect(out).toMatchObject({ status: "refused", refusal: CONTINUATION_CLOSED_SENTENCE });
    expect(JSON.stringify(out)).not.toContain("coding_diag_2");
  });
});
