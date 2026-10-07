import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return env;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Things a clone of a local repository will not carry over, for the caller to
 * see at trigger time: uncommitted changes, submodules, LFS-tracked files.
 * Best effort and read-only: git runs with GIT_* stripped and hooks/fsmonitor off.
 */
export async function localRepoWarnings(path: string): Promise<string[]> {
  const warnings: string[] = [];
  try {
    const { stdout } = await run(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", path, "status", "--porcelain"],
      { env: cleanGitEnv(), maxBuffer: 16 * 1024 * 1024 },
    );
    const count = stdout.split("\n").filter((line) => line.trim() !== "").length;
    if (count > 0) warnings.push(`${count} uncommitted ${count === 1 ? "file is" : "files are"} not included`);
  } catch {
    // An unreadable status is not worth failing a trigger over; preparing the run reports a broken repository.
  }
  if (await exists(join(path, ".gitmodules"))) {
    warnings.push("submodules (.gitmodules) are not initialized in the run's checkout");
  }
  try {
    const attributes = await readFile(join(path, ".gitattributes"), "utf8");
    if (/(^|\s)filter=lfs(\s|$)/m.test(attributes)) {
      warnings.push("Git LFS files (filter=lfs in .gitattributes) are not fetched into the run's checkout");
    }
  } catch {
    // no .gitattributes
  }
  return warnings;
}
