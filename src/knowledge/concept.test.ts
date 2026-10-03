import { describe, expect, it } from "vitest";
import { parseConcept } from "./concept.js";

const SHA = "b92f0a0606448cf4d1163b0420644fac997e2c05";
const good = `---
type: invariant
title: Store parity
tags: [jokes]
generated: { by: human:x, at: 2026-10-03T00:00:00Z }
custom_key: kept
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["knockknock/**"]
  citations:
    - { id: a, repo: github:o/r, path: knockknock/joke_store.py, lines: [14, 27], sha: ${SHA}, spanHash: sha256:${"a".repeat(64)} }
---

Body text.[^a]
`;

describe("parseConcept", () => {
  it("parses OKF fields and the wardby block, defaulting status to stable", () => {
    const result = parseConcept("store-parity.md", good);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.concept.type).toBe("invariant");
    expect(result.concept.status).toBe("stable");
    expect(result.concept.affects).toEqual(["knockknock/**"]);
    expect(result.concept.citations[0]).toMatchObject({ path: "knockknock/joke_store.py", lines: [14, 27] });
    expect(result.concept.frontMatter.custom_key).toBe("kept");
    expect(result.concept.body.trim()).toBe("Body text.[^a]");
  });
  it("accepts a plain OKF concept with no wardby block", () => {
    const result = parseConcept("x.md", "---\ntype: Playbook\n---\nSteps.\n");
    expect(result.ok && result.concept.citations).toEqual([]);
  });
  it("rejects missing front-matter, missing type, bad sha, bad lines", () => {
    expect(parseConcept("x.md", "no front matter").ok).toBe(false);
    expect(parseConcept("x.md", "---\ntitle: t\n---\n").ok).toBe(false);
    expect(parseConcept("x.md", good.replace(SHA, "abc")).ok).toBe(false);
    expect(parseConcept("x.md", good.replace("[14, 27]", "[27, 14]")).ok).toBe(false);
  });
  it("rejects a reserved file name as a concept", () => {
    expect(parseConcept("index.md", good).ok).toBe(false);
  });
});
