#!/usr/bin/env node
/**
 * Weekly "outdated majors" report (.github/workflows/outdated-report.yml).
 *
 * For the root package and each worker package that ships its own lockfile,
 * lists the direct dependencies whose latest published release is a higher
 * major than the locked version. 0.x packages (every minor is breaking under
 * semver) go in a separate table, and only once they are ZERO_X_MINOR_THRESHOLD
 * or more minors behind or the locked release is more than ZERO_X_MAX_AGE_DAYS
 * older than the latest, so a weekly-minor SDK does not keep the issue open.
 *
 * Informational only. Reads the lockfiles and registry metadata (`npm outdated
 * --package-lock-only`, `npm view <name> time`); installs nothing
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

/** 0.x packages ship a breaking minor almost weekly; flag them only past either bar. */
const ZERO_X_MINOR_THRESHOLD = 5;
const ZERO_X_MAX_AGE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ""));
  return match ? match.slice(1, 4).map(Number) : null;
}

/** Publish times for every version of `name` (read-only registry metadata). */
async function publishTimes(name, cwd) {
  const { stdout } = await run("npm", ["view", name, "time", "--json"], { cwd, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

/**
 * Classifies one outdated dependency:
 *   { kind: "major", behind }              a higher major (incl. 0.x -> 1.x)
 *   { kind: "zero", behind, ageDays }      0.x, a higher minor, past a threshold
 *   null                                   neither, or `latest` is a prerelease
 */
async function classify(name, current, latest, cwd) {
  // A prerelease on the `latest` dist-tag is not a release to move to yet.
  if (String(latest ?? "").includes("-")) return null;
  const c = parse(current);
  const l = parse(latest);
  if (!c || !l) return null;
  if (l[0] > c[0]) return { kind: "major", behind: l[0] - c[0] };
  if (c[0] !== 0 || l[0] !== 0 || l[1] <= c[1]) return null;
  const behind = l[1] - c[1];
  const times = await publishTimes(name, cwd);
  const currentAt = Date.parse(times[current] ?? "");
  const latestAt = Date.parse(times[latest] ?? "");
  const ageDays =
    Number.isFinite(currentAt) && Number.isFinite(latestAt) ? Math.floor((latestAt - currentAt) / DAY_MS) : null;
  if (behind >= ZERO_X_MINOR_THRESHOLD || (ageDays !== null && ageDays > ZERO_X_MAX_AGE_DAYS)) {
    return { kind: "zero", behind, ageDays };
  }
  return null;
}

async function report(root) {
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const outdated = await npmOutdated(root);
  const majors = [];
  const zeros = [];
  for (const [name, info] of Object.entries(outdated)) {
    for (const entry of Array.isArray(info) ? info : [info]) {
      // npm only fills `current` from an installed tree; the lockfile is the
      // source of truth for what ships, and needs no install.
      const current = lock.packages?.[`node_modules/${name}`]?.version ?? entry.current;
      const result = await classify(name, current, entry.latest, root);
      if (result?.kind === "major") majors.push({ name, current, latest: entry.latest, ...result });
      if (result?.kind === "zero") zeros.push({ name, current, latest: entry.latest, ...result });
    }
  }
  const byBehind = (a, b) => b.behind - a.behind || a.name.localeCompare(b.name);
  return { label: relative(repoRoot, root) || "(root)", majors: majors.sort(byBehind), zeros: zeros.sort(byBehind) };
}

const output = process.argv[2];
if (!output) {
  console.error("usage: node scripts/outdated-report.mjs <body.md>");
  process.exit(2);
}

const sections = [];
for (const root of await packageRoots()) sections.push(await report(root));
const count = sections.reduce((sum, s) => sum + s.majors.length + s.zeros.length, 0);

const lines = [
  "Direct dependencies whose latest release is a major version or more ahead of the locked one.",
  `0.x packages (where every minor is breaking under semver) are listed separately, and only once they are ${ZERO_X_MINOR_THRESHOLD} or more minors behind or the locked release is more than ${ZERO_X_MAX_AGE_DAYS} days older than the latest.`,
  "Informational, regenerated weekly by `.github/workflows/outdated-report.yml`; this issue closes itself when both lists are empty.",
  "",
];
const anyMajors = sections.some((s) => s.majors.length > 0);
const anyZeros = sections.some((s) => s.zeros.length > 0);
if (anyMajors) {
  lines.push("## Majors behind", "");
  for (const { label, majors } of sections) {
    if (majors.length === 0) continue;
    lines.push(
      `### \`${label}\``,
      "",
      "| Package | Current (lockfile) | Latest | Majors behind |",
      "| --- | --- | --- | --- |",
    );
    for (const r of majors) lines.push(`| \`${r.name}\` | ${r.current} | ${r.latest} | ${r.behind} |`);
    lines.push("");
  }
}
if (anyZeros) {
  lines.push("## 0.x minors behind", "");
  for (const { label, zeros } of sections) {
    if (zeros.length === 0) continue;
    lines.push(
      `### \`${label}\``,
      "",
      "| Package | Current (lockfile) | Latest | 0.x minors behind | Days between releases |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const r of zeros)
      lines.push(`| \`${r.name}\` | ${r.current} | ${r.latest} | ${r.behind} | ${r.ageDays ?? "?"} |`);
    lines.push("");
  }
}
if (!anyMajors && !anyZeros) lines.push("Nothing is behind.", "");
lines.push(`_Generated ${new Date().toISOString().slice(0, 10)}._`);

await writeFile(output, `${lines.join("\n")}\n`, "utf8");
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `count=${count}\n`, "utf8");
console.log(`${count} dependencies flagged (majors behind, or 0.x past the threshold)`);
