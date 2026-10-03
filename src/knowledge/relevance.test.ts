import { describe, expect, it } from "vitest";
import type { ParsedConcept } from "./concept.js";
import { driftScope } from "./relevance.js";

const concept = (path: string, affects: string[], cited: string[]): ParsedConcept => ({
  path,
  type: "pitfall",
  status: "stable",
  roles: [],
  affects,
  body: "",
  frontMatter: {},
  citations: cited.map((p) => ({
    repo: "github:o/r",
    path: p,
    sha: "a".repeat(40),
    spanHash: `sha256:${"0".repeat(64)}`,
  })),
});
const concepts = [
  concept("seed.md", ["knockknock/jokes.py"], ["knockknock/joke_store.py"]),
  concept("voter.md", ["knockknock/web.py"], []),
];

describe("driftScope", () => {
  it("selects concepts by citation path and affects glob", () => {
    expect(
      driftScope({
        changedPaths: ["knockknock/joke_store.py"],
        changedPathsComplete: true,
        bundlePath: "docs/knowledge",
        concepts,
      }),
    ).toEqual({ concepts: ["seed.md"], reason: "changed_files" });
    expect(
      driftScope({
        changedPaths: ["knockknock/web.py"],
        changedPathsComplete: true,
        bundlePath: "docs/knowledge",
        concepts,
      }),
    ).toEqual({ concepts: ["voter.md"], reason: "changed_files" });
  });
  it("selects an edited concept file", () => {
    expect(
      driftScope({
        changedPaths: ["docs/knowledge/voter.md"],
        changedPathsComplete: true,
        bundlePath: "docs/knowledge",
        concepts,
      }),
    ).toEqual({ concepts: ["voter.md"], reason: "bundle_edited" });
  });
  it("returns null when nothing relevant changed", () => {
    expect(
      driftScope({ changedPaths: ["README.md"], changedPathsComplete: true, bundlePath: "docs/knowledge", concepts }),
    ).toBeNull();
  });
  it("takes everything when the change list is incomplete", () => {
    expect(
      driftScope({ changedPaths: [], changedPathsComplete: false, bundlePath: "docs/knowledge", concepts }),
    ).toEqual({ concepts: ["seed.md", "voter.md"], reason: "unknown_changes" });
  });
});
