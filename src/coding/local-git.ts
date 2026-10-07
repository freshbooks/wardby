/**
 * Read-only git helpers shared by the local review host and the local VCS
 * remote: GIT_* stripped, hooks/fsmonitor/signature display off, strict ref and
 * path validation. Never imported by protocol.ts (which keeps no relative imports).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const SHA = /^[0-9a-f]{40}$/;
export const MAX_REF_CHARS = 250;
export const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return env;
}

function gitArgs(dir: string, args: string[]): string[] {
  return [
    "--literal-pathspecs",
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "log.showSignature=false",
    "-c",
    "gpg.program=",
    "-c",
    "diff.external=",
    "-C",
    dir,
    ...args,
  ];
}

/** Runs git read-only in `dir`. Throws the raw execFile error; callers decide what a failure means. */
export async function localGit(dir: string, args: string[], maxBuffer = GIT_MAX_BUFFER): Promise<string> {
  const { stdout } = await run("git", gitArgs(dir, args), { env: cleanGitEnv(), maxBuffer, encoding: "utf8" });
  return stdout;
}

/** Like localGit, but the raw stdout bytes (for content that must be validated as UTF-8). */
export async function localGitBytes(dir: string, args: string[], maxBuffer = GIT_MAX_BUFFER): Promise<Buffer> {
  const { stdout } = await run("git", gitArgs(dir, args), { env: cleanGitEnv(), maxBuffer, encoding: "buffer" });
  return stdout;
}

/** True for a plain branch/tag name that cannot read as an option or revision expression. */
export async function isSafeRefName(dir: string, name: string): Promise<boolean> {
  if (
    !name ||
    name.length > MAX_REF_CHARS ||
    name.startsWith("-") ||
    name.includes("\0") ||
    name.includes("@{") ||
    !/^[\x21-\x7e]+$/.test(name)
  ) {
    return false;
  }
  try {
    await localGit(dir, ["check-ref-format", "--branch", name], 64 * 1024);
    return true;
  } catch {
    return false;
  }
}

/** A path inside the repository: relative, no `.`/`..`/empty segments, no NUL. */
export function isSafeRepoPath(path: string): boolean {
  return !(
    !path ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}
