/**
 * Dependency cache keys, derived only on the proxy. A worker names nothing
 * in a key except its project folder (validated here); the lock hash comes
 * from a lockfile plan the proxy approved, and the repository, image and
 * policy come from the run's own records.
 */
import { createHash, randomUUID } from "node:crypto";

/** The only ecosystem the cache serves today. */
export const DEPENDENCY_CACHE_ECOSYSTEM = "npm";
/** Lockfile hashes one session may hold (plans beyond this are not recorded). */
export const MAX_DEPENDENCY_CACHE_LOCK_HASHES = 8;

const LOCK_HASH = /^[0-9a-f]{64}$/;
/** A project-path segment: no leading dot (no `.`, `..` or dot-folder), no
 *  separators, whitespace or control characters. */
const PROJECT_SEGMENT = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]{0,99}$/;
const MAX_PROJECT_SEGMENTS = 3;

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : canonical(item)));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // Code-unit order (the default sort), never locale order: the hash must
    // be the same on every host.
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

/** JSON with object keys sorted, so equal values always serialize alike. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value)) ?? "null";
}

/** sha256 of the canonical `{ allowlist, policy }` of a run. */
export function computePolicyHash(allowlist: unknown, policy: unknown): string {
  return sha256Hex(canonicalJson({ allowlist: allowlist ?? null, policy: policy ?? null }));
}

export function isLockHash(value: string): boolean {
  return LOCK_HASH.test(value);
}

/**
 * The project folder relative to the repository root, or null when it is not
 * acceptable: "." (or absent) is the root; otherwise 1-3 plain segments, none
 * empty, none starting with a dot, none named node_modules.
 */
export function parseProjectPath(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || raw === ".") return ".";
  const segments = raw.split("/");
  if (segments.length > MAX_PROJECT_SEGMENTS) return null;
  for (const segment of segments) {
    if (!PROJECT_SEGMENT.test(segment) || segment === "node_modules") return null;
  }
  return raw;
}

export interface SnapshotKeyParts {
  repository: string;
  projectPath: string;
  lockHash: string;
  workerImage: string;
  policyHash: string;
}

export interface SnapshotKey extends SnapshotKeyParts {
  ecosystem: string;
  /** The opaque id a worker downloads the derived key by: sha256 of the canonical identity tuple. */
  keyId: string;
}

export function deriveSnapshotKey(parts: SnapshotKeyParts): SnapshotKey {
  const identity = {
    ecosystem: DEPENDENCY_CACHE_ECOSYSTEM,
    repository: parts.repository,
    projectPath: parts.projectPath,
    lockHash: parts.lockHash,
    workerImage: parts.workerImage,
    policyHash: parts.policyHash,
  };
  return { ...identity, keyId: sha256Hex(canonicalJson(identity)) };
}

/**
 * A fresh blob key for one upload of `key`. Each upload writes its own object
 * (the random suffix), so a concurrent or refused upload can never replace
 * the bytes of a snapshot already committed; a row always names the exact
 * object its sha256 and size describe.
 */
export function newBlobKey(key: SnapshotKey): string {
  return (
    `dependency-cache/${key.ecosystem}/${sha256Hex(key.repository)}/${sha256Hex(key.projectPath).slice(0, 16)}/` +
    `${key.lockHash}-${sha256Hex(key.workerImage).slice(0, 16)}-${key.policyHash.slice(0, 16)}-${randomUUID()}.tgz`
  );
}
