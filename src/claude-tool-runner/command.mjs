import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_COMMAND_BYTES = 16 * 1024;
export const MAX_TIMEOUT_MS = 120_000;
/** The launcher's setup for this run (src/providers/jobs/claude-tool-setup.ts). */
export const TOOL_SETUP_ENV = "WARDBY_TOOL_SETUP";
/** The npm shim (src/coding-worker/npm-shim.mjs), ahead of the real npm. */
export const SHIM_DIRECTORY = "/opt/wardby/bin";

const RESERVED_NAMES = new Set(["HOME", "LANG", "PATH", "TMPDIR", TOOL_SETUP_ENV]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_ENV_ENTRIES = 64;
const MAX_ENV_VALUE_BYTES = 4096;
const MAX_FILES = 8;
const MAX_FILE_BYTES = 16 * 1024;
const FILE_MODES = new Set([0o600, 0o644]);
const EMPTY_SETUP = Object.freeze({ env: Object.freeze({}), files: Object.freeze([]) });

export function toolEnvironment() {
  return {
    HOME: "/home/wardby",
    LANG: "C.UTF-8",
    PATH: `${SHIM_DIRECTORY}:/usr/local/bin:/usr/bin:/bin`,
    TMPDIR: "/tmp",
  };
}

/**
 * The launcher's setup: registry settings and service test variables for every command, and the
 * registry's config files under the workspace's .cache. Trusted input, still checked: anything
 * unexpected stops the tool runner before it reports ready, rather than running half-configured.
 */
export function parseToolSetup(raw, workspacePath = "/workspace") {
  if (raw === undefined || raw === "") return EMPTY_SETUP;
  const invalid = () => new Error("tool_setup_invalid");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) throw invalid();
  if (!value.env || typeof value.env !== "object" || Array.isArray(value.env)) throw invalid();
  const entries = Object.entries(value.env);
  if (entries.length > MAX_ENV_ENTRIES) throw invalid();
  const env = {};
  for (const [name, text] of entries) {
    if (!ENV_NAME.test(name) || RESERVED_NAMES.has(name)) throw invalid();
    if (typeof text !== "string" || text.includes("\0") || Buffer.byteLength(text) > MAX_ENV_VALUE_BYTES)
      throw invalid();
    env[name] = text;
  }
  if (!Array.isArray(value.files) || value.files.length > MAX_FILES) throw invalid();
  const cacheRoot = `${workspacePath}/.cache/`;
  const files = value.files.map((file) => {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") throw invalid();
    if (!file.path.startsWith(cacheRoot) || file.path.split("/").includes("..")) throw invalid();
    if (!FILE_MODES.has(file.mode) || Buffer.byteLength(file.content) > MAX_FILE_BYTES) throw invalid();
    return { path: file.path, content: file.content, mode: file.mode };
  });
  return Object.freeze({ env: Object.freeze(env), files: Object.freeze(files) });
}

/**
 * Rewritten before every command: the workspace is seeded after the tool runner starts, and a
 * command may delete its own .cache. Best effort: a file that can't be written leaves the package
 * manager unauthenticated, which the registry reports on its own.
 */
async function applySetupFiles(setup) {
  for (const file of setup.files) {
    try {
      await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
      await rm(file.path, { force: true });
      await writeFile(file.path, file.content, { mode: file.mode, flag: "wx" });
    } catch {
      // See above.
    }
  }
}

export async function runCommand(command, timeoutMs, workspacePath = "/workspace", setup = EMPTY_SETUP) {
  if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) throw new Error("tool_command_too_large");
  const timeout = Math.max(1_000, Math.min(MAX_TIMEOUT_MS, timeoutMs));
  await applySetupFiles(setup);
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd: workspacePath,
      env: { ...setup.env, ...toolEnvironment() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let size = 0;
    let timedOut = false;
    const append = (chunk) => {
      if (size >= MAX_OUTPUT_BYTES) return;
      const bounded = Buffer.from(chunk).subarray(0, MAX_OUTPUT_BYTES - size);
      chunks.push(bounded);
      size += bounded.byteLength;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeout);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), output: Buffer.concat(chunks).toString("utf8") });
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ code: 1, output: "tool execution failed" });
    });
  });
}
