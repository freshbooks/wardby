/**
 * Python detection for the quickstart's coding step: reads the committed root
 * of the base commit (never the working tree) with the hardened git helpers.
 */
import { localGit } from "../coding/local-git.js";

const MARKER = /^(?:pyproject\.toml|setup\.py|setup\.cfg|Pipfile|requirements.*\.txt)$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** True when `sha`'s root tree holds a Python project file. Any failure means not Python. */
export async function detectPythonProject(dir: string, sha: string): Promise<boolean> {
  if (!OBJECT_ID.test(sha)) return false;
  try {
    const listing = await localGit(dir, ["ls-tree", "-z", sha]);
    return listing
      .split("\0")
      .filter(Boolean)
      .some((entry) => {
        // "<mode> <type> <object>\t<name>"
        const tab = entry.indexOf("\t");
        if (tab < 0) return false;
        const type = entry.slice(0, tab).split(" ")[1];
        return type === "blob" && MARKER.test(entry.slice(tab + 1));
      });
  } catch {
    return false;
  }
}
