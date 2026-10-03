import { describe, expect, it } from "vitest";
import type { GraphRun } from "../api/types";
import { changeFilters, initialFilters, visibleRuns } from "./filters";

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
