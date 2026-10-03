import { describe, expect, it } from "vitest";
import type { GraphRun } from "../api/types";
import { bucketRuns } from "../timeline/buckets";
import { changeFilters, initialFilters, matchesFilters, visibleRuns } from "./filters";

const r = (id: string, at: string, parentRunId: string | null = null): GraphRun =>
  ({ id, parentRunId, agentId: "a", agentName: "a", status: "succeeded", startedAt: at }) as GraphRun;

describe("timeRange", () => {
  const runs = [
    r("root", "2026-01-01T10:00:00.000Z"),
    r("child", "2026-01-01T12:00:00.000Z", "root"),
    r("late", "2026-01-01T15:00:00.000Z"),
  ];
  const range = { from: Date.parse("2026-01-01T11:00:00.000Z"), to: Date.parse("2026-01-01T13:00:00.000Z") };

  it("keeps runs started in range plus their ancestors", () => {
    const ids = visibleRuns(runs, { ...initialFilters, timeRange: range }).map((x) => x.id);
    expect(ids).toEqual(["root", "child"]);
  });

  it("includes both edges and shows everything without a range", () => {
    const edge = { from: Date.parse("2026-01-01T15:00:00.000Z"), to: Date.parse("2026-01-01T15:00:00.000Z") };
    expect(visibleRuns(runs, { ...initialFilters, timeRange: edge }).map((x) => x.id)).toEqual(["late"]);
    expect(visibleRuns(runs, initialFilters)).toHaveLength(3);
  });

  it("clears the range when the window changes, not otherwise", () => {
    const prev = { ...initialFilters, timeRange: range };
    expect(changeFilters(prev, { ...prev, window: "6h" }).timeRange).toBeNull();
    expect(changeFilters(prev, { ...prev, search: "x" }).timeRange).toEqual(range);
  });
});

describe("matchesFilters ignoreTimeRange (timeline feed)", () => {
  const T0 = Date.UTC(2026, 0, 1, 12, 0);
  const mk = (id: string, min: number, status: string): GraphRun =>
    ({
      id,
      agentId: "ag",
      agentName: "agent",
      status,
      costUsd: 0,
      parentRunId: null,
      startedAt: new Date(T0 + min * 60_000).toISOString(),
    }) as unknown as GraphRun;
  const all = [mk("ok1", 5, "succeeded"), mk("bad1", 10, "failed"), mk("ok2", 50, "succeeded")];
  const spec = { start: T0, end: T0 + 60 * 60_000, count: 6 };
  const fed = (f: typeof initialFilters) => all.filter((r) => matchesFilters(r, f, { ignoreTimeRange: true }));

  it("drops unchecked statuses from buckets and markers", () => {
    const statuses = new Set(initialFilters.statuses);
    statuses.delete("failed");
    const runs = fed({ ...initialFilters, statuses });
    expect(runs.map((r) => r.id)).toEqual(["ok1", "ok2"]);
    expect(bucketRuns(runs, spec).reduce((n, b) => n + b.counts.failed, 0)).toBe(0);
  });

  it("keeps runs outside the time range", () => {
    const timeRange = { from: T0, to: T0 + 20 * 60_000 };
    expect(fed({ ...initialFilters, timeRange }).map((r) => r.id)).toEqual(["ok1", "bad1", "ok2"]);
    expect(all.filter((r) => matchesFilters(r, { ...initialFilters, timeRange })).map((r) => r.id)).toEqual([
      "ok1",
      "bad1",
    ]);
  });

  it("follows search and agent filters", () => {
    expect(fed({ ...initialFilters, search: "bad1" }).map((r) => r.id)).toEqual(["bad1"]);
    expect(fed({ ...initialFilters, agents: new Set(["other"]) })).toEqual([]);
  });
});
