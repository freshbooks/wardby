// npm run codex:rerecord — makes a Codex SDK bump mechanical:
//   1. aligns the root devDependency @openai/codex-sdk with the version the
//      coding worker pins (src/coding-worker/package.json) and installs it;
//   2. records that Codex CLI's OpenAI Responses requests against a local fake
//      upstream (CODEX_RECORD=1 codex-compatibility.test.ts) into
//      src/providers/coding-proxy/fixtures/codex-<version>-responses-requests.json,
//      replacing the previous version's fixture;
//   3. runs the compatibility test (real Codex through the real proxy) and the
//      proxy's fixture-replay tests;
//   4. prints the request-shape diff between the previous fixture and the new
//      one, for review before anything in the proxy's allowlist changes.
// Exits non-zero when recording or the tests fail; the diff is printed either way.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { diffRequestShapes, formatShapeDiff, requestShape, type FixtureEntry } from "./codex-request-shape.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURES = join(REPO, "src/providers/coding-proxy/fixtures");
const FIXTURE = /^codex-(.+)-responses-requests\.json$/;
const fixturePath = (version: string) => join(FIXTURES, `codex-${version}-responses-requests.json`);

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function installedVersion(name: string): string | undefined {
  const manifest = join(REPO, "node_modules", name, "package.json");
  return existsSync(manifest) ? readJson<{ version: string }>(manifest).version : undefined;
}

function run(step: string, command: string, args: string[], env: NodeJS.ProcessEnv = {}): boolean {
  console.log(`\n=== ${step}: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: REPO, stdio: "inherit", env: { ...process.env, ...env } });
  return result.status === 0;
}

const pinned = readJson<{ dependencies: Record<string, string> }>(join(REPO, "src/coding-worker/package.json"))
  .dependencies["@openai/codex-sdk"];
if (!semver.valid(pinned)) {
  console.error(`src/coding-worker/package.json must pin @openai/codex-sdk to an exact version (found "${pinned}").`);
  process.exit(1);
}

// (a) Root devDependency == worker pin, installed (with the host's Codex binary).
const declared = readJson<{ devDependencies: Record<string, string> }>(join(REPO, "package.json")).devDependencies[
  "@openai/codex-sdk"
];
if (
  declared !== pinned ||
  installedVersion("@openai/codex-sdk") !== pinned ||
  installedVersion("@openai/codex") !== pinned
) {
  if (!run("install", "npm", ["install", "--save-dev", "--save-exact", `@openai/codex-sdk@${pinned}`])) process.exit(1);
}

// The baseline for the diff: this version's existing fixture, else the newest other one.
const existing = readdirSync(FIXTURES)
  .map((name) => FIXTURE.exec(name)?.[1])
  .filter((version): version is string => version !== undefined);
const baselineVersion = existing.includes(pinned)
  ? pinned
  : existing.filter((version) => semver.valid(version)).sort(semver.rcompare)[0];
const baseline = baselineVersion ? readJson<FixtureEntry[]>(fixturePath(baselineVersion)) : [];

// (b) Record.
if (
  !run("record", "npx", ["vitest", "run", "src/coding-worker/codex-compatibility.test.ts"], { CODEX_RECORD: "1" }) ||
  !existsSync(fixturePath(pinned))
) {
  console.error("\nRecording failed; the fixture was not (re)written.");
  process.exit(1);
}
run("format", "npx", ["prettier", "--write", fixturePath(pinned)]);
for (const version of existing) {
  if (version !== pinned) rmSync(fixturePath(version));
}

// (c) Compatibility (real Codex through the real proxy) and fixture replay.
const testsPassed = run("test", "npx", [
  "vitest",
  "run",
  "src/coding-worker/codex-compatibility.test.ts",
  "src/providers/coding-proxy/proxy.test.ts",
]);

// (d) What changed in the requests the proxy must accept.
const recorded = readJson<FixtureEntry[]>(fixturePath(pinned));
console.log(
  `\n${formatShapeDiff(
    diffRequestShapes(requestShape(baseline), requestShape(recorded)),
    baselineVersion ? `codex ${baselineVersion} (previous fixture)` : "no previous fixture",
    `codex ${pinned} (${recorded.length} recorded requests)`,
  )}`,
);
if (!testsPassed) {
  console.error(
    "\nThe compatibility or proxy tests failed. Review the request-shape diff above: new keys, item types,\n" +
      "tool types or values must be reviewed (see docs/coding-worker-isolation.md) before the allowlist is widened.",
  );
  process.exit(1);
}
console.log(
  `\nRe-recorded for Codex ${pinned}. Review the diff above, then commit the fixture, package.json and lockfile.`,
);
