import { describe, expect, it } from "vitest";
import { globRegex, matchesGlob } from "./glob.js";

describe("globRegex", () => {
  it("matches one segment with * and any depth with **", () => {
    expect(matchesGlob("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/x/a.ts", "src/*.ts")).toBe(false);
    expect(matchesGlob("src/x/a.ts", "src/**")).toBe(true);
    expect(matchesGlob("docs/knowledge/a.md", "docs/knowledge/**")).toBe(true);
  });
  it("escapes regex metacharacters and supports ?", () => {
    expect(matchesGlob("a.b", "a.b")).toBe(true);
    expect(matchesGlob("axb", "a.b")).toBe(false);
    expect(matchesGlob("a1", "a?")).toBe(true);
    expect(globRegex("x+y").test("x+y")).toBe(true);
  });
});
