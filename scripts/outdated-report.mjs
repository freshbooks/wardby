#!/usr/bin/env node
/**
 * Weekly "outdated majors" report (.github/workflows/outdated-report.yml).
 *
 * For the root package and each worker package that ships its own lockfile,
 * lists the direct dependencies whose latest published release is across a
 * breaking-change boundary from the locked version: a higher major, or for a
 * 0.x package a higher minor (0.x minors are breaking under semver, and that is
 * what a caret range treats them as).
 *
 * Informational only. Reads the lockfiles and the registry; installs nothing
 * and runs no package scripts. Writes a Markdown issue body to the path given
 * as the first argument and, under GitHub Actions, `count=<n>` to
 * $GITHUB_OUTPUT. Always exits 0 unless the report itself cannot be produced.
 *
 *   node scripts/outdated-report.mjs report.md
 */
import { execFile } from "node:child_process";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Root plus every src/<worker>/ that has its own package.json and lockfile. */
async function packageRoots() {
  const roots = [repoRoot];
  for (const entry of await readdir(join(repoRoot, "src"), { withFileTypes: true })) {
    const dir = join(repoRoot, "src", entry.name);
    if (entry.isDirectory() && existsSync(join(dir, "package.json")) && existsSync(join(dir, "package-lock.json"))) {
      roots.push(dir);
    }
  }
  return roots;
}

/** `npm outdated` exits 1 whenever anything is outdated; that is a result, not a failure. */
async function npmOutdated(cwd) {
  let stdout;
  try {
    ({ stdout } = await run("npm", ["outdated", "--json", "--package-lock-only"], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (err) {
    if (typeof err?.stdout !== "string" || err.stdout.trim() === "") throw err;
    stdout = err.stdout;
  }
  return stdout.trim() === "" ? {} : JSON.parse(stdout);
}

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ""));
  return match ? match.slice(1, 4).map(Number) : null;
}

/** How many breaking-change boundaries separate `current` from `latest` (0 = none). */
function breakingStepsBehind(current, latest) {
  // A prerelease on the `latest` dist-tag is not a release to move to yet.
  if (String(latest ?? "").includes("-")) return 0;
  const c = parse(current);
  const l = parse(latest);
  if (!c || !l) return 0;
  if (l[0] > c[0]) return l[0] - c[0];
  if (c[0] === 0 && l[0] === 0 && l[1] > c[1]) return l[1] - c[1];
  return 0;
}

async function report(root) {
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const outdated = await npmOutdated(root);
  const rows = [];
  for (const [name, info] of Object.entries(outdated)) {
    for (const entry of Array.isArray(info) ? info : [info]) {
      // npm only fills `current` from an installed tree; the lockfile is the
      // source of truth for what ships, and needs no install.
      const current = lock.packages?.[`node_modules/${name}`]?.version ?? entry.current;
      const steps = breakingStepsBehind(current, entry.latest);
      if (steps > 0) rows.push({ name, current, latest: entry.latest, steps });
    }
  }
  rows.sort((a, b) => b.steps - a.steps || a.name.localeCompare(b.name));
  return { label: relative(repoRoot, root) || "(root)", rows };
}

const output = process.argv[2];
if (!output) {
  console.error("usage: node scripts/outdated-report.mjs <body.md>");
  process.exit(2);
}

const sections = [];
for (const root of await packageRoots()) sections.push(await report(root));
const count = sections.reduce((sum, s) => sum + s.rows.length, 0);

const lines = [
  "Direct dependencies whose latest release is a major version or more ahead of the locked one",
  "(for 0.x packages, a minor version: semver treats those as breaking).",
  "Informational, regenerated weekly by `.github/workflows/outdated-report.yml`; this issue closes itself when the list is empty.",
  "",
];
for (const { label, rows } of sections) {
  if (rows.length === 0) continue;
  lines.push(`### \`${label}\``, "", "| Package | Current (lockfile) | Latest | Behind |", "| --- | --- | --- | --- |");
  for (const r of rows) lines.push(`| \`${r.name}\` | ${r.current} | ${r.latest} | ${r.steps} |`);
  lines.push("");
}
lines.push(`_Generated ${new Date().toISOString().slice(0, 10)}._`);

await writeFile(output, `${lines.join("\n")}\n`, "utf8");
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `count=${count}\n`, "utf8");
console.log(`${count} dependencies a major version or more behind`);
