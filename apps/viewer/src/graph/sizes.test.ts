import { describe, expect, it } from "vitest";
import { tailTruncate } from "./sizes";

describe("tailTruncate", () => {
  it("leaves short text alone", () => {
    expect(tailTruncate("agent", 18)).toBe("agent");
    expect(tailTruncate("a".repeat(18), 18)).toBe("a".repeat(18));
  });
  it("keeps the end of long text", () => {
    const out = tailTruncate("dbos-agent-129e9e1b-b793-4787-81a3-01940c3ea271", 18);
    expect(out).toBe("…81a3-01940c3ea271");
    expect(out).toHaveLength(18);
  });
});
