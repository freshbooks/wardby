/**
 * The run dependency cache, read by the coding proxy. Off unless
 * WARDBY_DEPENDENCY_CACHE=true and a blob store (BLOB_STORE) is configured.
 */
import type { BlobStoreConfig } from "../providers/storage/index.js";
import { loadBlobStoreConfig } from "./providers.js";

const MIB = 1024 * 1024;
const DAY_MS = 86_400_000;

export type DependencyCacheConfig =
  | { enabled: false; reason: "disabled" | "no_blob_store" }
  | {
      enabled: true;
      blobStore: BlobStoreConfig;
      /** Largest snapshot accepted (WARDBY_DEPENDENCY_CACHE_MAX_SNAPSHOT_MB). */
      maxSnapshotBytes: number;
      /** Snapshot bytes kept per repository (WARDBY_DEPENDENCY_CACHE_REPO_CAP_MB). */
      repoCapBytes: number;
      /** Snapshot bytes kept in all (WARDBY_DEPENDENCY_CACHE_TOTAL_CAP_MB). */
      totalCapBytes: number;
      /** A snapshot's lifetime from creation (WARDBY_DEPENDENCY_CACHE_MAX_AGE_DAYS). */
      maxAgeMs: number;
      /** How long after its proxy session starts a run may upload (WARDBY_DEPENDENCY_CACHE_UPLOAD_SECONDS). */
      uploadMs: number;
    };

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

export function loadDependencyCacheConfig(env: NodeJS.ProcessEnv = process.env): DependencyCacheConfig {
  const flag = env.WARDBY_DEPENDENCY_CACHE?.trim();
  if (flag !== undefined && flag !== "" && flag !== "true" && flag !== "false") {
    throw new Error("WARDBY_DEPENDENCY_CACHE must be true or false.");
  }
  if (flag !== "true") return { enabled: false, reason: "disabled" };
  const blobStore = loadBlobStoreConfig(env);
  if (!blobStore) return { enabled: false, reason: "no_blob_store" };
  return {
    enabled: true,
    blobStore,
    maxSnapshotBytes: positiveInteger(env, "WARDBY_DEPENDENCY_CACHE_MAX_SNAPSHOT_MB", 1024) * MIB,
    repoCapBytes: positiveInteger(env, "WARDBY_DEPENDENCY_CACHE_REPO_CAP_MB", 4096) * MIB,
    totalCapBytes: positiveInteger(env, "WARDBY_DEPENDENCY_CACHE_TOTAL_CAP_MB", 20480) * MIB,
    maxAgeMs: positiveInteger(env, "WARDBY_DEPENDENCY_CACHE_MAX_AGE_DAYS", 14) * DAY_MS,
    uploadMs: positiveInteger(env, "WARDBY_DEPENDENCY_CACHE_UPLOAD_SECONDS", 900) * 1000,
  };
}
