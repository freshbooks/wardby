import type { GraphRun } from "../api/types";
import { STATUS_GROUPS, statusGroup, type StatusGroup } from "../state/filters";

export interface Bucket {
  /** Inclusive start, exclusive end (the last bucket also includes `end`), epoch ms. */
  from: number;
  to: number;
  counts: Record<StatusGroup, number>;
  total: number;
  costUsd: number;
}

export interface BucketSpec {
  start: number;
  end: number;
  count: number;
}

export function emptyCounts(): Record<StatusGroup, number> {
  return Object.fromEntries(STATUS_GROUPS.map((g) => [g, 0])) as Record<StatusGroup, number>;
}

/** Bucket index for a timestamp, or -1 when it falls outside [start, end]. */
export function bucketIndex(t: number, { start, end, count }: BucketSpec): number {
  if (!(t >= start && t <= end) || count < 1 || end <= start) return -1;
  return Math.min(count - 1, Math.floor(((t - start) / (end - start)) * count));
}

/** Divide [start, end] into `count` equal buckets and tally runs by start time and status group. */
export function bucketRuns(runs: Iterable<GraphRun>, spec: BucketSpec): Bucket[] {
  const { start, end, count } = spec;
  if (count < 1 || end <= start) return [];
  const width = (end - start) / count;
  const buckets: Bucket[] = Array.from({ length: count }, (_, i) => ({
    from: start + i * width,
    to: start + (i + 1) * width,
    counts: emptyCounts(),
    total: 0,
    costUsd: 0,
  }));
  for (const run of runs) {
    const i = bucketIndex(Date.parse(run.startedAt), spec);
    if (i < 0) continue;
    const b = buckets[i]!;
    b.counts[statusGroup(run.status)] += 1;
    b.total += 1;
    b.costUsd += run.costUsd;
  }
  return buckets;
}
