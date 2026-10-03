import { describe, expect, it } from "vitest";
import { formatTokens } from "./text";

describe("formatTokens", () => {
  it("is compact at every scale", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(9_540)).toBe("9.5k");
    expect(formatTokens(92_392)).toBe("92k");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });
});
