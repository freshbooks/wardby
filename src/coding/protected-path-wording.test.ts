import { describe, expect, it } from "vitest";
import {
  PROTECTED_PATH_CATEGORY,
  PROTECTED_PATH_HOST_LINE,
  protectedPathFromError,
  protectedPathSentence,
} from "./protected-path-wording.js";

describe("protectedPathFromError", () => {
  it("reads the path out of a vcs_protected_path error", () => {
    expect(protectedPathFromError(new Error("vcs_protected_path:CODEOWNERS"))).toBe("CODEOWNERS");
    expect(protectedPathFromError(new Error("vcs_protected_path:.wardby/other.yaml"))).toBe(".wardby/other.yaml");
    expect(protectedPathFromError("vcs_protected_path:CODEOWNERS")).toBe("CODEOWNERS");
  });

  it("finds no path in any other error", () => {
    expect(protectedPathFromError(new Error("vcs_protected_path_invalid"))).toBeNull();
    expect(protectedPathFromError(new Error("vcs_changed_file_limit"))).toBeNull();
    expect(protectedPathFromError(new Error("vcs_protected_path:"))).toBeNull();
    expect(protectedPathFromError(null)).toBeNull();
  });
});

describe("protectedPathSentence", () => {
  it("names a well-formed path in a single backtick span", () => {
    expect(protectedPathSentence("CODEOWNERS")).toBe(
      "its changes include `CODEOWNERS`, which this agent may not edit, so none of its changes were kept. Ask again without changing that file, or have the repository owner make that change.",
    );
  });

  it("neutralises a backtick and collapses a newline so the path stays one line and one code span", () => {
    const sentence = protectedPathSentence(".wardby/`weird`\nname.yaml");
    expect(sentence).toBe(
      "its changes include `.wardby/'weird' name.yaml`, which this agent may not edit, so none of its changes were kept. Ask again without changing that file, or have the repository owner make that change.",
    );
    expect(sentence.split("\n")).toHaveLength(1);
    // Exactly the two backticks that open and close the span -- none from the path.
    expect(sentence.split("`")).toHaveLength(3);
  });

  it("caps an unreasonably long path with an ellipsis", () => {
    const long = "a/".repeat(150) + "file.ts";
    const sentence = protectedPathSentence(long);
    const [, named] = /`([^`]*)`/.exec(sentence) ?? [];
    expect(named).toBeDefined();
    expect(named.length).toBeLessThanOrEqual(201);
    expect(named.endsWith("…")).toBe(true);
  });

  it("falls back to a sentence without a name when nothing usable survives sanitising", () => {
    expect(protectedPathSentence("\n\u0000\u0007")).toBe(
      "its changes include a file this agent may not edit, so none of its changes were kept. Ask again without changing that file, or have the repository owner make that change.",
    );
    expect(protectedPathSentence(null)).toBe(
      "its changes include a file this agent may not edit, so none of its changes were kept. Ask again without changing that file, or have the repository owner make that change.",
    );
    expect(protectedPathSentence(undefined)).toBe(
      "its changes include a file this agent may not edit, so none of its changes were kept. Ask again without changing that file, or have the repository owner make that change.",
    );
  });
});

describe("constants", () => {
  it("names the failure category and the fixed host-status line", () => {
    expect(PROTECTED_PATH_CATEGORY).toBe("protected_path");
    expect(PROTECTED_PATH_HOST_LINE).toBe(
      "A sub-run could not open its changes: it changed a file its agent may not edit, so none of its changes were kept.",
    );
  });
});
