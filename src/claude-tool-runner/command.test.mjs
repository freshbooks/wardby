import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_OUTPUT_BYTES, SHIM_DIRECTORY, parseToolSetup, runCommand, toolEnvironment } from "./command.mjs";

test("runs commands in the supplied workspace with a scrubbed environment and bounded output", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardby-claude-tools-"));
  try {
    const env = toolEnvironment();
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);

    const result = await runCommand('test -z "$ANTHROPIC_API_KEY" && printf absent', 1_000, workspace);
    assert.deepEqual(result, { code: 0, output: "absent" });

    const bounded = await runCommand("head -c 70000 /dev/zero", 1_000, workspace);
    assert.equal(bounded.code, 0);
    assert.equal(Buffer.byteLength(bounded.output), MAX_OUTPUT_BYTES);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

const setupFor = (workspace) =>
  JSON.stringify({
    schemaVersion: 1,
    env: {
      npm_config_registry: "http://wardby-proxy:8787/registry/npm/",
      DATABASE_URL: "postgres://test@127.0.0.1/test",
    },
    files: [
      {
        path: `${workspace}/.cache/npm/npmrc`,
        content: "//wardby-proxy:8787/registry/npm/:_authToken=rgt_x\n",
        mode: 0o600,
      },
    ],
  });

test("parses the launcher's setup and refuses anything else", () => {
  assert.deepEqual(parseToolSetup(undefined), { env: {}, files: [] });
  const parsed = parseToolSetup(setupFor("/workspace"));
  assert.equal(parsed.env.npm_config_registry, "http://wardby-proxy:8787/registry/npm/");
  assert.equal(parsed.files[0].path, "/workspace/.cache/npm/npmrc");
  const bad = [
    "not json",
    JSON.stringify({ schemaVersion: 2, env: {}, files: [] }),
    JSON.stringify({ schemaVersion: 1, env: { PATH: "/evil" }, files: [] }),
    JSON.stringify({ schemaVersion: 1, env: { HOME: "/root" }, files: [] }),
    JSON.stringify({ schemaVersion: 1, env: { "bad-name": "x" }, files: [] }),
    JSON.stringify({ schemaVersion: 1, env: { A: 1 }, files: [] }),
    JSON.stringify({ schemaVersion: 1, env: {}, files: [{ path: "/etc/passwd", content: "x", mode: 0o600 }] }),
    JSON.stringify({
      schemaVersion: 1,
      env: {},
      files: [{ path: "/workspace/.cache/../x", content: "x", mode: 0o600 }],
    }),
    JSON.stringify({ schemaVersion: 1, env: {}, files: [{ path: "/workspace/.cache/a", content: "x", mode: 0o777 }] }),
  ];
  for (const raw of bad) assert.throws(() => parseToolSetup(raw), /tool_setup_invalid/, raw);
});

test("gives each command the setup's variables and files, the shim first on PATH, and never the raw setup", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardby-claude-tools-setup-"));
  try {
    const setup = parseToolSetup(setupFor(workspace), workspace);
    const result = await runCommand(
      'printf "%s|%s|%s" "$npm_config_registry" "$DATABASE_URL" "${WARDBY_TOOL_SETUP:-unset}"',
      5_000,
      workspace,
      setup,
    );
    assert.deepEqual(result, {
      code: 0,
      output: "http://wardby-proxy:8787/registry/npm/|postgres://test@127.0.0.1/test|unset",
    });
    assert.equal(
      await readFile(join(workspace, ".cache/npm/npmrc"), "utf8"),
      "//wardby-proxy:8787/registry/npm/:_authToken=rgt_x\n",
    );
    assert.equal((await stat(join(workspace, ".cache/npm/npmrc"))).mode & 0o777, 0o600);
    assert.ok(toolEnvironment().PATH.startsWith(`${SHIM_DIRECTORY}:`));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("rewrites a setup file a previous command deleted", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardby-claude-tools-setup-"));
  try {
    const setup = parseToolSetup(setupFor(workspace), workspace);
    await runCommand("rm -rf .cache", 5_000, workspace, setup);
    const result = await runCommand("cat .cache/npm/npmrc", 5_000, workspace, setup);
    assert.equal(result.code, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
