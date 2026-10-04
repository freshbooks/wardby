import { describe, expect, it } from "vitest";
import { nextStepLines } from "./index.js";

describe("quickstart next-step hint", () => {
  it("offers both recipes to the assistant when an MCP client is configured", () => {
    const text = nextStepLines("claude").join("\n");
    expect(text).toContain("Ask your assistant one of:");
    expect(text).toContain("Set up the Wardby architecture keeper for this repository");
    expect(text).toContain("Set up a Wardby builder for this repository");
    expect(text).toContain("help open agent-recipes");
  });

  it("prints only the guide line when no MCP client was configured", () => {
    const text = nextStepLines("none").join("\n");
    expect(text).not.toContain("Ask your assistant");
    expect(text).toContain("help open agent-recipes");
  });
});
