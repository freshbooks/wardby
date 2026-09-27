import { describe, expect, it } from "vitest";
import { WARDBY_PROTECTED_PATHS, isWellFormedProtectedPath, protectsSomePath } from "./protected-paths.js";

describe("isWellFormedProtectedPath", () => {
  it.each([
    ".github/workflows/**",
    "CODEOWNERS",
    "src/*.ts",
    "docs/?.md",
    "!docs/CODEOWNERS",
    "!.wardby/services.yaml",
  ])("accepts %s", (path) => {
    expect(isWellFormedProtectedPath(path)).toBe(true);
  });

  it.each([
    "",
    "!",
    "!!x",
    "/etc/passwd",
    "!/etc/passwd",
    "./x",
    "!./x",
    "a\\b",
    "a//b",
    "../x",
    "!../x",
    "!**",
    "!*",
    "!.wardby/*",
    "!.wardby/**",
    "!.github/**",
    "!docs/CODEOWNER?",
    "![ab]",
    "!{a,b}",
  ])("refuses %j", (path) => {
    expect(isWellFormedProtectedPath(path)).toBe(false);
  });

  it("accepts the fixed baseline, whose exception is a literal path", () => {
    expect(WARDBY_PROTECTED_PATHS.every(isWellFormedProtectedPath)).toBe(true);
  });
});

describe("protectsSomePath", () => {
  it("needs at least one entry that is not an exception", () => {
    expect(protectsSomePath(["CODEOWNERS", "!docs/CODEOWNERS"])).toBe(true);
    expect(protectsSomePath(["!docs/CODEOWNERS"])).toBe(false);
  });
});
