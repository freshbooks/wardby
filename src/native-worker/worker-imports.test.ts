import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Modules a sandbox worker must never load: the database client, the runner
 * (control-plane writes), provider adapters that hold credentials, secret and
 * datastore backends, and process configuration. Type-only imports are erased
 * and do not count.
 */
const FORBIDDEN = [
  "core/db.ts",
  "core/runner.ts",
  "core/dispatch.ts",
  "core/secrets.ts",
  "generated/prisma/",
  "config/",
  "providers/secrets/",
  "providers/datastore/",
  "providers/executor/",
  "providers/jobs/",
  "providers/llm/routing.ts",
  "providers/llm/anthropic.ts",
  "providers/llm/openai.ts",
  "providers/llm/claude-provider.ts",
];

// Runtime (non-type) relative imports and re-exports, including multi-line import lists.
// Bounded by ";" so a match never runs from one statement into the next.
const IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^;]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/gm;

function runtimeGraph(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, spec] of readFileSync(file, "utf8").matchAll(IMPORT)) {
      visit(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  };
  visit(resolve(SRC, entry));
  return [...seen].map((file) => relative(SRC, file));
}

it("the native sandbox worker's runtime import graph has no database, provider credential, or config module", () => {
  // The process entry, so its transports (stdio, HTTP) are covered too.
  const graph = runtimeGraph("native-worker/main.ts");
  expect(graph).toContain("native-worker/http-transport.ts");
  expect(graph).toContain("core/engine-native.ts");
  expect(graph.filter((file) => FORBIDDEN.some((prefix) => file.startsWith(prefix)))).toEqual([]);
});
