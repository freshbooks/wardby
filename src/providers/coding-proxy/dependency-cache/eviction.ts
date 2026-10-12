/**
 * Dependency cache eviction: a periodic pass inside the proxy, coordinated
 * across replicas by a Postgres advisory lock (the store's
 * withEvictionLock). It removes snapshots past the maximum age (by creation,
 * so every snapshot is rebuilt at least that often), then the least recently
 * used beyond each repository's cap, then beyond the total cap. A blob is
 * deleted before its row, so a failed blob delete leaves the row for the next
 * pass to retry rather than an orphaned blob.
 */
import { logger } from "../../../core/logger.js";
import type { BlobStore } from "../../storage/types.js";
import type { DependencyCacheStore, EvictionRow } from "./store.js";

const evictionLog = logger.child({ module: "dependency-cache" });

/** How often the proxy runs an eviction pass. */
export const DEFAULT_EVICTION_INTERVAL_MS = 60 * 60_000;

export interface EvictionLimits {
  maxAgeMs: number;
  repoCapBytes: number;
  totalCapBytes: number;
}

const leastRecentlyUsed = (a: EvictionRow, b: EvictionRow) =>
  a.lastUsedAt.getTime() - b.lastUsedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The snapshots to evict, in the order to evict them. */
export function selectEvictions(rows: readonly EvictionRow[], limits: EvictionLimits, now: Date): EvictionRow[] {
  const cutoff = now.getTime() - limits.maxAgeMs;
  const evicted: EvictionRow[] = rows
    .filter((row) => row.createdAt.getTime() <= cutoff)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || leastRecentlyUsed(a, b));
  let kept = rows.filter((row) => row.createdAt.getTime() > cutoff);

  const byRepository = new Map<string, EvictionRow[]>();
  for (const row of kept) byRepository.set(row.repository, [...(byRepository.get(row.repository) ?? []), row]);
  const overRepoCap = new Set<string>();
  for (const repoRows of byRepository.values()) {
    let total = repoRows.reduce((sum, row) => sum + row.sizeBytes, 0);
    for (const row of [...repoRows].sort(leastRecentlyUsed)) {
      if (total <= limits.repoCapBytes) break;
      evicted.push(row);
      overRepoCap.add(row.id);
      total -= row.sizeBytes;
    }
  }
  kept = kept.filter((row) => !overRepoCap.has(row.id));

  let total = kept.reduce((sum, row) => sum + row.sizeBytes, 0);
  for (const row of [...kept].sort(leastRecentlyUsed)) {
    if (total <= limits.totalCapBytes) break;
    evicted.push(row);
    total -= row.sizeBytes;
  }
  return evicted;
}

export interface EvictionOptions {
  store: DependencyCacheStore;
  blobs: Pick<BlobStore, "delete">;
  limits: EvictionLimits;
  now?: () => Date;
}

/** One eviction pass; `ran` is false when another holder had the lock. */
export async function runEviction(
  options: EvictionOptions,
): Promise<{ ran: boolean; deleted: number; failed: number }> {
  const result = { ran: false, deleted: 0, failed: 0 };
  result.ran = await options.store.withEvictionLock(async () => {
    const rows = await options.store.listForEviction();
    for (const row of selectEvictions(rows, options.limits, (options.now ?? (() => new Date()))())) {
      try {
        await options.blobs.delete(row.blobKey);
      } catch (error) {
        result.failed += 1;
        evictionLog.warn(
          { event: "dependency_cache.evict_blob_failed", snapshotId: row.id, err: error },
          "dependency cache: a snapshot's blob could not be deleted; the next pass retries",
        );
        continue;
      }
      await options.store.delete(row.id);
      result.deleted += 1;
    }
  });
  return result;
}

/** Runs an eviction pass every `intervalMs` (the first one interval after start). */
export function startEviction(options: EvictionOptions & { intervalMs?: number }): { stop(): void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runEviction(options)
      .then((result) => {
        if (result.deleted > 0 || result.failed > 0)
          evictionLog.info(
            { event: "dependency_cache.evicted", deleted: result.deleted, failed: result.failed },
            "dependency cache eviction pass",
          );
      })
      .catch((error: unknown) => {
        evictionLog.warn({ event: "dependency_cache.evict_failed", err: error }, "dependency cache eviction failed");
      })
      .finally(() => {
        running = false;
      });
  }, options.intervalMs ?? DEFAULT_EVICTION_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
