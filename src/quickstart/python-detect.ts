/**
 * Python detection for the quickstart's coding step: reads the committed root
 * of the base commit (never the working tree) with the hardened git helpers.
 */
import { localGit } from "../coding/local-git.js";

const MARKER = /^(?:pyproject\.toml|setup\.py|setup\.cfg|Pipfile|requirements.*\.txt)$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface RootEntry {
  name: string;
  mode: string;
  type: string;
  object: string;
}

/** The entries of `sha`'s root tree. Throws when `sha` is not a full object id or git fails. */
export async function rootEntries(dir: string, sha: string): Promise<RootEntry[]> {
  if (!OBJECT_ID.test(sha)) throw new Error("not a full commit id");
  const listing = await localGit(dir, ["ls-tree", "-z", sha]);
  const entries: RootEntry[] = [];
  for (const entry of listing.split("\0")) {
    // "<mode> <type> <object>\t<name>"
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, object] = entry.slice(0, tab).split(" ");
    entries.push({ name: entry.slice(tab + 1), mode, type, object });
  }
  return entries;
}

/** True when `sha`'s root tree holds a Python project file. Any failure means not Python. */
export async function detectPythonProject(dir: string, sha: string): Promise<boolean> {
  try {
    return (await rootEntries(dir, sha)).some((entry) => entry.type === "blob" && MARKER.test(entry.name));
  } catch {
    return false;
  }
}
