import { describe, expect, it } from "vitest";
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
});
