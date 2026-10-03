import { matchesGlob } from "../core/glob.js";
import type { ParsedConcept } from "./concept.js";

export interface DriftScope {
  concepts: string[];
  reason: "changed_files" | "bundle_edited" | "unknown_changes";
}

export function driftScope(input: {
  changedPaths: string[];
  changedPathsComplete: boolean;
  bundlePath: string;
  concepts: ParsedConcept[];
}): DriftScope | null {
  const all = input.concepts.map((c) => c.path).sort();
  if (!input.changedPathsComplete) return all.length ? { concepts: all, reason: "unknown_changes" } : null;
  const prefix = `${input.bundlePath}/`;
  const bundleEdited = input.changedPaths.some((p) => p.startsWith(prefix));
  const selected = input.concepts.filter((concept) =>
    input.changedPaths.some(
      (changed) =>
        changed === prefix + concept.path ||
        concept.citations.some((c) => c.path === changed) ||
        concept.affects.some((glob) => matchesGlob(changed, glob)),
    ),
  );
  if (!selected.length) return null;
  return { concepts: selected.map((c) => c.path).sort(), reason: bundleEdited ? "bundle_edited" : "changed_files" };
}
