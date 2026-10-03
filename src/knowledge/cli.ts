import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { checkBundle } from "./check.js";
import { DEFAULT_KNOWLEDGE_BUNDLE_PATH } from "./concept.js";

const USAGE = "usage: wardby knowledge check [dir] [--root <repo root>] [--strict] [--json]";

export function parseKnowledgeArgs(args: string[]): { dir: string; root: string; strict: boolean; json: boolean } {
  const [sub, ...rest] = args;
  if (sub !== "check") throw new Error(USAGE);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { root: { type: "string" }, strict: { type: "boolean" }, json: { type: "boolean" } },
  });
  if (positionals.length > 1) throw new Error(USAGE);
  return {
    dir: positionals[0] ?? DEFAULT_KNOWLEDGE_BUNDLE_PATH,
    root: values.root ?? ".",
    strict: values.strict ?? false,
    json: values.json ?? false,
  };
}

export function loadBundle(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".md")) files.set(relative(dir, full).split(sep).join("/"), readFileSync(full, "utf8"));
    }
  };
  walk(dir);
  return files;
}

export async function knowledgeCommand(args: string[]): Promise<void> {
  const options = parseKnowledgeArgs(args);
  const root = resolve(options.root);
  const files = loadBundle(resolve(root, options.dir));
  const issues = checkBundle({ files }, (path) => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch {
      return null;
    }
  });
  if (options.json) process.stdout.write(`${JSON.stringify({ issues }, null, 2)}\n`);
  else {
    for (const issue of issues)
      process.stdout.write(`${issue.severity} ${issue.code} ${options.dir}/${issue.file}: ${issue.message}\n`);
    process.stdout.write(
      `${files.size} files checked, ${issues.filter((i) => i.severity === "error").length} errors, ${issues.filter((i) => i.severity === "warning").length} warnings\n`,
    );
  }
  if (issues.some((i) => i.severity === "error" || (options.strict && i.severity === "warning"))) process.exitCode = 1;
}
