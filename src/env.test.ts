import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const envModule = fileURLToPath(new URL("./env.ts", import.meta.url));

/** Loads src/env.ts in a fresh process for `projectDir` and returns what it printed to stderr. */
function loadEnvIn(projectDir: string): { stderr: string; probe: string } {
  const script = `await import(${JSON.stringify(envModule)}); process.stdout.write(process.env.ENV_TEST_PROBE ?? "");`;
  // tsx is resolved here, not from the child's cwd (a temp directory with no node_modules).
  const result = spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script],
    {
      cwd: projectDir,
      env: { PATH: process.env.PATH, WARDBY_PROJECT_DIR: projectDir },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) throw new Error(`env load failed (${result.status}): ${result.stderr}`);
  return { stderr: result.stderr, probe: result.stdout };
}

describe("environment loading", () => {
  it("prints nothing when the project has no .env files", () => {
    const dir = mkdtempSync(join(tmpdir(), "wardby-env-"));
    expect(loadEnvIn(dir).stderr).not.toContain("dotenv-flow");
  });

  it("still loads the project's .env when it exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "wardby-env-"));
    writeFileSync(join(dir, ".env"), "ENV_TEST_PROBE=loaded\n");
    expect(loadEnvIn(dir).probe).toBe("loaded");
  });
});
