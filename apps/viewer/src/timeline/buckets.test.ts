import { describe, expect, it } from "vitest";
import type { GraphRun } from "../api/types";
import { bucketIndex, bucketRuns } from "./buckets";

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const MIN = 60_000;
const run = (id: string, atMs: number, over: Partial<GraphRun> = {}): GraphRun =>
  ({ id, status: "succeeded", costUsd: 0.1, startedAt: new Date(atMs).toISOString(), ...over }) as GraphRun;
const spec = { start: T0, end: T0 + 60 * MIN, count: 6 };

describe("bucketRuns", () => {
  it("returns empty buckets for no runs and none for a degenerate span", () => {
    const b = bucketRuns([], spec);
    expect(b).toHaveLength(6);
    expect(b.every((x) => x.total === 0 && x.costUsd === 0)).toBe(true);
    expect(bucketRuns([], { ...spec, count: 0 })).toEqual([]);
    expect(bucketRuns([], { start: 5, end: 5, count: 4 })).toEqual([]);
  });

  it("splits the span into equal contiguous buckets", () => {
    const b = bucketRuns([], spec);
    expect(b[0]!.from).toBe(T0);
    expect(b[0]!.to).toBe(T0 + 10 * MIN);
    expect(b[5]!.to).toBe(T0 + 60 * MIN);
  });

  it("tallies status groups and cost per bucket", () => {
    const b = bucketRuns(
      [
        run("a", T0 + 1 * MIN),
        run("b", T0 + 2 * MIN, { status: "failed", costUsd: 0.5 }),
        run("c", T0 + 3 * MIN, { status: "budget_exhausted", costUsd: 0.25 }),
        run("d", T0 + 4 * MIN, { status: "running", costUsd: 0 }),
        run("e", T0 + 5 * MIN, { status: "pending", costUsd: 0 }),
      ],
      spec,
    );
    expect(b[0]!.counts).toEqual({ succeeded: 1, failed: 2, running: 1, pending: 1 });
    expect(b[0]!.total).toBe(5);
    expect(b[0]!.costUsd).toBeCloseTo(0.85);
  });

  it("puts a run on a bucket boundary in the later bucket, and one at the end in the last", () => {
    const b = bucketRuns([run("a", T0 + 10 * MIN), run("z", T0 + 60 * MIN), run("s", T0)], spec);
    expect(b[0]!.total).toBe(1);
    expect(b[1]!.total).toBe(1);
    expect(b[5]!.total).toBe(1);
  });

  it("ignores runs outside the window", () => {
    const b = bucketRuns([run("old", T0 - 1), run("future", T0 + 60 * MIN + 1)], spec);
    expect(b.reduce((n, x) => n + x.total, 0)).toBe(0);
    expect(bucketIndex(T0 - 1, spec)).toBe(-1);
  });
});
