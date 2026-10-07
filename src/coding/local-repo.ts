import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { delimiter, isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Repository identity prefix for a git folder on the wardby host: `local:/abs/path`. */
export const LOCAL_REPO_PREFIX = "local:";

export type LocalRepoErrorCode =
  "local_repo_not_allowed" | "local_repo_not_found" | "local_ref_not_found" | "local_branch_conflict";

export class LocalRepoError extends Error {
  constructor(
    readonly code: LocalRepoErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "LocalRepoError";
  }
}

export function isLocalRepository(value: string): boolean {
  return value.startsWith(LOCAL_REPO_PREFIX);
}

/** Syntactic only: absolute, no NUL, normalized; returns "local:/abs/path" (no trailing slash). */
export function normalizeLocalRepository(value: string): string {
  if (!isLocalRepository(value)) throw new Error("local repository must start with local:");
  const path = value.slice(LOCAL_REPO_PREFIX.length);
  if (path.includes("\0")) throw new Error("local repository path must not contain NUL");
  if (!isAbsolute(path)) throw new Error("local repository path must be absolute");
  return `${LOCAL_REPO_PREFIX}${resolve(path)}`;
}

/** Splits LOCAL_REPO_ROOTS on the platform path delimiter; roots are realpath'd, missing ones are reported. */
export function loadLocalRepoRoots(env: NodeJS.ProcessEnv): { roots: string[]; missing: string[] } {
  const roots: string[] = [];
  const missing: string[] = [];
  for (const entry of (env.LOCAL_REPO_ROOTS ?? "").split(delimiter)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      roots.push(realpathSync(resolve(trimmed)));
    } catch {
      missing.push(trimmed);
    }
  }
  return { roots, missing };
}

/** Realpath the target; it must sit at or under a trusted root and be the top level of a git work tree. */
export async function resolveLocalRepository(
  repository: string,
  roots: readonly string[],
): Promise<{ repository: string; path: string }> {
  const requested = normalizeLocalRepository(repository).slice(LOCAL_REPO_PREFIX.length);
  if (roots.length === 0) {
    throw new LocalRepoError("local_repo_not_allowed", "no local repository roots are configured (LOCAL_REPO_ROOTS)");
  }
  let target: string;
  try {
    target = await realpath(requested);
  } catch {
    // A missing path cannot be proven to live under a root by realpath; compare lexically first.
    const lexicallyInside = roots.some((r) => requested === r || requested.startsWith(r.endsWith(sep) ? r : r + sep));
    if (!lexicallyInside) {
      throw new LocalRepoError("local_repo_not_allowed", "repository is outside the configured local roots");
    }
    throw new LocalRepoError("local_repo_not_found", "repository path does not exist");
  }
  if (!roots.some((r) => target === r || target.startsWith(r.endsWith(sep) ? r : r + sep))) {
    throw new LocalRepoError("local_repo_not_allowed", "repository is outside the configured local roots");
  }
  let top: string;
  try {
    const { stdout } = await run("git", ["-C", target, "rev-parse", "--show-toplevel"]);
    top = await realpath(stdout.trim());
  } catch {
    throw new LocalRepoError("local_repo_not_found", "path is not a git work tree");
  }
  if (top !== target) {
    throw new LocalRepoError("local_repo_not_found", "path is not the top level of a git work tree");
  }
  return { repository: normalizeLocalRepository(`${LOCAL_REPO_PREFIX}${target}`), path: target };
}
