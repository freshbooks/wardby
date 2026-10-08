/**
 * The packages a repository declares, offered as the quickstart builder's
 * package allowlist. Reads the manifests at the root of the base commit
 * (never the working tree) with the hardened git helpers, keeps the bare
 * top-level names that are valid in their ecosystem, normalizes PyPI names
 * (PEP 503) and the extras they name (PEP 685), de-duplicates (merging a
 * package's extras into one entry), and caps each ecosystem at
 * MAX_REPO_PACKAGES.
 */
import { localGitBytes } from "../coding/local-git.js";
import { npmAdapter } from "../coding/registry/npm.js";
import { isPypiProjectName, MAX_EXTRAS, normalizePypiName, parseExtras } from "../coding/registry/pypi.js";
import {
  packageJsonNames,
  packageJsonOwnNames,
  pyprojectNames,
  pyprojectOwnNames,
  requirementsNames,
} from "./manifests.js";
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
  /** The repository's own package names the manifest declares (never offered). */
  own?: (text: string) => string[];
}

function manifestFor(name: string): Manifest | null {
  if (name === "package.json") return { ecosystem: "npm", read: packageJsonNames, own: packageJsonOwnNames };
  if (name === "pyproject.toml") return { ecosystem: "pypi", read: pyprojectNames, own: pyprojectOwnNames };
  if (/^requirements.*\.txt$/.test(name)) return { ecosystem: "pypi", read: requirementsNames };
  return null;
}

/** The longest allowlist entry the coding profile accepts. */
const MAX_ENTRY_LENGTH = 256;

/** A PyPI requirement as read ("Psycopg[Binary]"): its normalized name and
 *  extras, or null when the name is not valid. An invalid extras list drops
 *  the extras, never the package. */
function pypiRequirement(spec: string): { name: string; extras: string[] } | null {
  const match = spec.match(/^([^[]*)(?:\[(.*)\])?$/);
  if (!match || match[1].length > 214 || !isPypiProjectName(match[1])) return null;
  return { name: normalizePypiName(match[1]), extras: match[2] === undefined ? [] : (parseExtras(match[2]) ?? []) };
}

/** The allowlist entry for a PyPI package and the extras found for it. */
function pypiEntry(name: string, extras: ReadonlySet<string>): string {
  const sorted = [...extras].sort().slice(0, MAX_EXTRAS);
  const entry = sorted.length > 0 ? `${name}[${sorted.join(",")}]` : name;
  return entry.length <= MAX_ENTRY_LENGTH ? entry : name;
}

/** The npm name as it goes on the allowlist, or null when it is not a valid bare npm name. */
function npmAllowlistName(name: string): string | null {
  if (name.length > 214) return null;
  try {
    const entry = npmAdapter.parseAllowlistEntry(name);
    return !entry.wildcard && entry.range === undefined && entry.name === name ? name : null;
  } catch {
    return null;
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * A note goes to the terminal, and file names and scan errors can carry
 * repository text (a TOML key's \u001b escape decodes to a real ESC): keep
 * printable ASCII only, so a repository cannot send terminal control sequences.
 */
function printable(note: string): string {
  return note.replace(/[^\x20-\x7e]/g, "?");
}

export async function readRepoPackages(dir: string, sha: string): Promise<RepoPackages> {
  let entries;
  try {
    entries = await rootEntries(dir, sha);
  } catch {
    return { allowlist: {}, notes: [] };
  }
  const found: Record<Ecosystem, Set<string>> = { npm: new Set(), pypi: new Set() };
  /** PyPI name -> the extras any manifest names for it. */
  const pypiExtras = new Map<string, Set<string>>();
  /** The repository's own package names (PyPI ones normalized): offering
   *  them would let a public package of the same name into the sandbox. */
  const own: Record<Ecosystem, Set<string>> = { npm: new Set(), pypi: new Set() };
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
      const text = decoder.decode(bytes).replace(/^\uFEFF/, "");
      names = manifest.read(text);
      for (const name of manifest.own?.(text) ?? []) {
        own[manifest.ecosystem].add(manifest.ecosystem === "pypi" ? normalizePypiName(name) : name);
      }
    } catch (error) {
      const reason = error instanceof Error && !("code" in error) ? `: ${error.message}` : "";
      notes.push(`Could not read the dependencies in ${entry.name}${reason}; it was skipped.`);
      continue;
    }
    for (const name of names) {
      if (manifest.ecosystem === "pypi") {
        const requirement = pypiRequirement(name);
        if (!requirement) continue;
        found.pypi.add(requirement.name);
        const extras = pypiExtras.get(requirement.name) ?? new Set<string>();
        for (const extra of requirement.extras) extras.add(extra);
        pypiExtras.set(requirement.name, extras);
        continue;
      }
      const kept = npmAllowlistName(name);
      if (kept) found.npm.add(kept);
    }
  }

  const allowlist: RepoPackages["allowlist"] = {};
  for (const ecosystem of ["npm", "pypi"] as const) {
    const names = [...found[ecosystem]].filter((name) => !own[ecosystem].has(name)).sort();
    if (names.length > MAX_REPO_PACKAGES) {
      notes.push(
        `The repository declares ${names.length} ${ECOSYSTEM_LABELS[ecosystem]} packages, more than the ${MAX_REPO_PACKAGES} the quickstart offers; none of them were added.`,
      );
    } else if (names.length > 0) {
      allowlist[ecosystem] =
        ecosystem === "pypi" ? names.map((name) => pypiEntry(name, pypiExtras.get(name) ?? new Set())) : names;
    }
  }
  return { allowlist, notes: notes.map(printable) };
}
