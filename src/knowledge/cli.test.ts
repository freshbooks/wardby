import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBundle, parseKnowledgeArgs } from "./cli.js";

describe("parseKnowledgeArgs", () => {
  it("defaults the dir and root", () => {
    expect(parseKnowledgeArgs(["check"])).toEqual({ dir: "docs/knowledge", root: ".", strict: false, json: false });
  });
  it("reads flags and an explicit dir", () => {
    expect(parseKnowledgeArgs(["check", "kb", "--root", "/r", "--strict", "--json"])).toEqual({
      dir: "kb",
      root: "/r",
      strict: true,
      json: true,
    });
  });
  it("rejects an unknown subcommand", () => {
    expect(() => parseKnowledgeArgs(["fix"])).toThrow(/usage/i);
  });
});

describe("loadBundle", () => {
  it("loads .md files recursively with bundle-relative keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "index.md"), "x");
    writeFileSync(join(dir, "sub", "a.md"), "y");
    writeFileSync(join(dir, "notes.txt"), "z");
    expect([...loadBundle(dir).keys()].sort()).toEqual(["index.md", "sub/a.md"]);
  });
});
