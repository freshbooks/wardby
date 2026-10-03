import { describe, expect, it } from "vitest";
import { checkBundle } from "./check.js";
import { spanHash } from "./span-hash.js";

const SHA = "b".repeat(40);
const source = "line1\nline2\nline3\n";
const concept = (hash: string, extra = "") => `---
type: pitfall
wardby:
  schema: 1
  citations:
    - { repo: github:o/r, path: src/a.py, lines: [2, 3], sha: ${SHA}, spanHash: ${hash} }
${extra}---
Body.
`;
const index = "---\nokf_version: 0.2\n---\n\n# Pitfalls\n\n* [A](a.md) - a\n";
const reader = (files: Record<string, string>) => (path: string) => files[path] ?? null;
const codes = (issues: { code: string }[]) => issues.map((i) => i.code).sort();

describe("checkBundle", () => {
  it("passes a clean bundle", () => {
    const files = new Map([
      ["index.md", index],
      ["a.md", concept(spanHash(source, [2, 3])!)],
    ]);
    expect(checkBundle({ files }, reader({ "src/a.py": source }))).toEqual([]);
  });
  it("warns on a stale hash and an unverifiable citation", () => {
    const files = new Map([
      ["index.md", index],
      ["a.md", concept(`sha256:${"0".repeat(64)}`)],
    ]);
    expect(codes(checkBundle({ files }, reader({ "src/a.py": source })))).toEqual(["citation_stale"]);
    expect(codes(checkBundle({ files }, reader({})))).toEqual(["citation_unverifiable"]);
  });
  it("errors on a missing index, a broken index link, invalid concepts and secrets", () => {
    const hash = spanHash(source, [2, 3])!;
    expect(codes(checkBundle({ files: new Map([["a.md", concept(hash)]]) }, reader({ "src/a.py": source })))).toContain(
      "index_missing",
    );
    const broken = new Map([
      ["index.md", index + "* [B](b.md) - b\n"],
      ["a.md", concept(hash)],
    ]);
    expect(codes(checkBundle({ files: broken }, reader({ "src/a.py": source })))).toContain("index_link_broken");
    const invalid = new Map([
      ["index.md", index],
      ["a.md", "---\ntitle: x\n---\n"],
    ]);
    expect(codes(checkBundle({ files: invalid }, reader({})))).toContain("concept_invalid");
    const secret = new Map([
      ["index.md", index],
      ["a.md", concept(hash) + "\nghp_" + "x".repeat(36) + "\n"],
    ]);
    expect(codes(checkBundle({ files: secret }, reader({ "src/a.py": source })))).toContain("concept_secret");
  });
  it("warns when a concept is not linked from index.md", () => {
    const hash = spanHash(source, [2, 3])!;
    const files = new Map([
      ["index.md", index],
      ["a.md", concept(hash)],
      ["c.md", concept(hash)],
    ]);
    expect(codes(checkBundle({ files }, reader({ "src/a.py": source })))).toEqual(["concept_not_indexed"]);
  });
  it("treats anchored index links as links", () => {
    const hash = spanHash(source, [2, 3])!;
    const files = new Map([
      ["index.md", "# Pitfalls\n\n* [A](a.md#why) - a\n"],
      ["a.md", concept(hash)],
    ]);
    expect(checkBundle({ files }, reader({ "src/a.py": source }))).toEqual([]);
  });
  it("does not treat reindex.md as an index", () => {
    const hash = spanHash(source, [2, 3])!;
    const files = new Map([
      ["index.md", index],
      ["a.md", concept(hash)],
      ["reindex.md", concept(hash)],
    ]);
    expect(codes(checkBundle({ files }, reader({ "src/a.py": source })))).toEqual(["concept_not_indexed"]);
    const linkingFromConcept = new Map([
      ["index.md", index],
      ["a.md", concept(hash)],
      ["reindex.md", concept(hash) + "\n[B](b.md)\n"],
    ]);
    expect(codes(checkBundle({ files: linkingFromConcept }, reader({ "src/a.py": source })))).toEqual([
      "concept_not_indexed",
    ]);
  });
  it("ignores index links with a URL scheme", () => {
    const hash = spanHash(source, [2, 3])!;
    const files = new Map([
      ["index.md", index + "* [Spec](https://example.com/spec.md) - external\n"],
      ["a.md", concept(hash)],
    ]);
    expect(checkBundle({ files }, reader({ "src/a.py": source }))).toEqual([]);
  });
});
