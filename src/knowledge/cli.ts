import { readdirSync, readFileSync } from "node:fs";
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

/**
 * Every `.md` file under `dir`, keyed by bundle-relative POSIX path. Entry
 * types come from the directory listing itself (no separate stat, so nothing
 * can change between the check and the read), and symbolic links are skipped:
 * a bundle is plain files, and following links could loop or leave the bundle.
 */
export function loadBundle(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.set(relative(dir, full).split(sep).join("/"), readFileSync(full, "utf8"));
      }
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
