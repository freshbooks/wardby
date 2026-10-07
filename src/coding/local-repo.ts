import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { delimiter, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { LOCAL_REPO_PREFIX, isLocalRepository, normalizeLocalRepository } from "./protocol.js";

export { LOCAL_REPO_PREFIX, isLocalRepository, normalizeLocalRepository };

const run = promisify(execFile);

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return env;
}

export type LocalRepoErrorCode =
  | "local_repo_not_allowed"
  | "local_repo_not_found"
  | "local_ref_not_found"
  | "local_ref_invalid"
  | "local_path_invalid"
  | "local_branch_conflict";

export class LocalRepoError extends Error {
  constructor(
    readonly code: LocalRepoErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "LocalRepoError";
  }
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
    const { stdout } = await run("git", ["-C", target, "rev-parse", "--show-toplevel"], {
      env: cleanGitEnv(),
    });
    top = await realpath(stdout.trim());
  } catch {
    throw new LocalRepoError("local_repo_not_found", "path is not a git work tree");
  }
  if (top !== target) {
    throw new LocalRepoError("local_repo_not_found", "path is not the top level of a git work tree");
  }
  return { repository: normalizeLocalRepository(`${LOCAL_REPO_PREFIX}${target}`), path: target };
}
