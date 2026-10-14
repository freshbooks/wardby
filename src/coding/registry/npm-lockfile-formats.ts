/**
 * Every lockfile the npm registry route verifies and rewrites: npm's own
 * (package-lock.json, npm-shrinkwrap.json), pnpm's (pnpm-lock.yaml) and
 * yarn's (yarn.lock, classic and Berry). They all install from the same
 * registry, so they share one plan route (`POST /registry/npm/-/plan`),
 * which tells them apart by content, and one set of registry reads.
 *
 * Kept free of imports from npm.ts, which imports this module.
 */
import { normalizeNpmLockfile } from "./npm-lockfile.js";
import { npmLockfilePlan, parseNpmLockfile } from "./npm-plan.js";
import { isPnpmLockfile, normalizePnpmLockfile, parsePnpmLockfile } from "./pnpm-lockfile.js";
import { RegistryError, type LockfilePlanSupport, type ParsedLockfile } from "./types.js";
import {
  isYarnBerryLockfile,
  isYarnClassicLockfile,
  normalizeYarnLockfile,
  parseYarnLockfile,
} from "./yarn-lockfile.js";

/** Parses whichever supported lockfile `body` is. */
export function parseNpmClientLockfile(
  body: string,
  options: { maxEntries: number; proxyRegistryUrl: string },
): ParsedLockfile {
  if (body.trimStart().startsWith("{")) return parseNpmLockfile(body, options);
  if (isYarnClassicLockfile(body) || isYarnBerryLockfile(body)) return parseYarnLockfile(body, options);
  if (isPnpmLockfile(body)) return parsePnpmLockfile(body, options);
  throw new RegistryError(
    400,
    "wardby_lockfile_unsupported",
    "not a lockfile this registry verifies: send a package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml or yarn.lock",
  );
}

export const npmClientLockfilePlan: LockfilePlanSupport = { ...npmLockfilePlan, parse: parseNpmClientLockfile };

export const npmClientLockfiles = {
  names: ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"],
  normalize(content: string, registryUrl: string, name: string): string {
    if (name === "pnpm-lock.yaml") return normalizePnpmLockfile(content, registryUrl);
    if (name === "yarn.lock") return normalizeYarnLockfile(content, registryUrl);
    return normalizeNpmLockfile(content, registryUrl);
  },
} as const;
