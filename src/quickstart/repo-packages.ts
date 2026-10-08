/**
 * The packages a repository declares, offered as the quickstart builder's
 * package allowlist. Reads the manifests at the root of the base commit
 * (never the working tree) with the hardened git helpers, keeps the bare
 * top-level names that are valid in their ecosystem, normalizes PyPI names
 * (PEP 503), de-duplicates, and caps each ecosystem at MAX_REPO_PACKAGES.
 */
import { localGitBytes } from "../coding/local-git.js";
import { npmAdapter } from "../coding/registry/npm.js";
import { isPypiProjectName, normalizePypiName } from "../coding/registry/pypi.js";
import { packageJsonNames, pyprojectNames, requirementsNames } from "./manifests.js";
import { rootEntries } from "./python-detect.js";

export const MAX_REPO_PACKAGES = 200;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const REGULAR_FILE = /^100(?:644|755)$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

type Ecosystem = "npm" | "pypi";
const ECOSYSTEM_LABELS: Record<Ecosystem, string> = { npm: "npm", pypi: "PyPI" };

export interface RepoPackages {
  /** Ecosystems with at least one name; sorted, de-duplicated names. */
  allowlist: Partial<Record<Ecosystem, string[]>>;
  /** One line each: a manifest that was skipped, or an ecosystem over the cap. */
  notes: string[];
}

interface Manifest {
  ecosystem: Ecosystem;
  read: (text: string) => string[];
}

function manifestFor(name: string): Manifest | null {
  if (name === "package.json") return { ecosystem: "npm", read: packageJsonNames };
  if (name === "pyproject.toml") return { ecosystem: "pypi", read: pyprojectNames };
  if (/^requirements.*\.txt$/.test(name)) return { ecosystem: "pypi", read: requirementsNames };
  return null;
}

/** The name as it goes on the allowlist, or null when it is not a valid bare name in its ecosystem. */
function allowlistName(ecosystem: Ecosystem, name: string): string | null {
  if (name.length > 214) return null;
  if (ecosystem === "pypi") return isPypiProjectName(name) ? normalizePypiName(name) : null;
  try {
    const entry = npmAdapter.parseAllowlistEntry(name);
    return !entry.wildcard && entry.range === undefined && entry.name === name ? name : null;
  } catch {
    return null;
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });

export async function readRepoPackages(dir: string, sha: string): Promise<RepoPackages> {
  let entries;
  try {
    entries = await rootEntries(dir, sha);
  } catch {
    return { allowlist: {}, notes: [] };
  }
  const found: Record<Ecosystem, Set<string>> = { npm: new Set(), pypi: new Set() };
  const notes: string[] = [];
  const manifests = entries
    .filter((entry) => entry.type === "blob" && REGULAR_FILE.test(entry.mode) && OBJECT_ID.test(entry.object))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of manifests) {
    const manifest = manifestFor(entry.name);
    if (!manifest) continue;
    let names: string[];
    try {
      const bytes = await localGitBytes(dir, ["cat-file", "blob", entry.object], MAX_MANIFEST_BYTES);
      names = manifest.read(decoder.decode(bytes).replace(/^\uFEFF/, ""));
    } catch (error) {
      const reason = error instanceof Error && !("code" in error) ? `: ${error.message}` : "";
      notes.push(`Could not read the dependencies in ${entry.name}${reason}; it was skipped.`);
      continue;
    }
    for (const name of names) {
      const kept = allowlistName(manifest.ecosystem, name);
      if (kept) found[manifest.ecosystem].add(kept);
    }
  }

  const allowlist: RepoPackages["allowlist"] = {};
  for (const ecosystem of ["npm", "pypi"] as const) {
    const names = [...found[ecosystem]].sort();
    if (names.length > MAX_REPO_PACKAGES) {
      notes.push(
        `The repository declares ${names.length} ${ECOSYSTEM_LABELS[ecosystem]} packages, more than the ${MAX_REPO_PACKAGES} the quickstart offers; none of them were added.`,
      );
    } else if (names.length > 0) {
      allowlist[ecosystem] = names;
    }
  }
  return { allowlist, notes };
}
