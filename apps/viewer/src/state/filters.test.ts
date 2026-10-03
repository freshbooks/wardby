import { describe, expect, it } from "vitest";
import type { GraphRun } from "../api/types";
import { buildGraph } from "../graph/build";
import { bucketRuns } from "../timeline/buckets";
import { shownCost } from "./cost";
import { changeFilters, initialFilters, countByGroup, matchesFilters } from "./filters";

const r = (id: string, at: string, parentRunId: string | null = null): GraphRun =>
  ({ id, parentRunId, agentId: "a", agentName: "a", status: "succeeded", startedAt: at }) as GraphRun;

describe("timeRange", () => {
  const runs = [
    r("root", "2026-01-01T10:00:00.000Z"),
    r("child", "2026-01-01T12:00:00.000Z", "root"),
    r("late", "2026-01-01T15:00:00.000Z"),
  ];
  const range = { from: Date.parse("2026-01-01T11:00:00.000Z"), to: Date.parse("2026-01-01T13:00:00.000Z") };

  it("matches only runs started in range", () => {
    const ids = runs.filter((x) => matchesFilters(x, { ...initialFilters, timeRange: range })).map((x) => x.id);
    expect(ids).toEqual(["child"]);
  });

  it("includes both edges and shows everything without a range", () => {
    const edge = { from: Date.parse("2026-01-01T15:00:00.000Z"), to: Date.parse("2026-01-01T15:00:00.000Z") };
    const ids = (f: typeof initialFilters) => runs.filter((x) => matchesFilters(x, f)).map((x) => x.id);
    expect(ids({ ...initialFilters, timeRange: edge })).toEqual(["late"]);
    expect(ids(initialFilters)).toHaveLength(3);
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
      trigger: { kind: "manual" },
      outcomes: [],
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

describe("one search rule across graph, counts, cost and timeline", () => {
  const mk = (id: string, over: Partial<GraphRun>): GraphRun =>
    ({
      id,
      parentRunId: null,
      agentId: "ag",
      agentName: "agent",
      status: "succeeded",
      costUsd: 0.5,
      trigger: { kind: "manual" },
      outcomes: [],
      startedAt: "2026-01-01T12:10:00.000Z",
      ...over,
    }) as GraphRun;
  const pr = (repository: string, number: number) =>
    ({
      kind: "pull_request",
      provider: "github",
      repository,
      number,
      url: "u",
      state: "open",
      at: null,
    }) as GraphRun["outcomes"][number];
  const runs = [
    mk("r1", { outcomes: [pr("owner/repo", 12)] }),
    mk("r2", { trigger: { kind: "issue", provider: "jira", issueKey: "SCRUM-6" }, costUsd: 0.25 }),
    mk("r3", { trigger: { kind: "code_host", provider: "github", repository: "o/x", number: 12, event: "review" } }),
    mk("r4", {}),
  ];

  it.each([
    ["owner/repo", ["r1"]],
    ["scrum-6", ["r2"]],
    ["o/x#12", ["r3"]],
  ])("search %s matches the same runs everywhere", (search, ids) => {
    const f = { ...initialFilters, search };
    expect(shownCost(runs, f).matching.map((x) => x.id)).toEqual(ids);
    expect(
      buildGraph(runs, f, null)
        .nodes.filter((n) => n.type === "run")
        .map((n) => n.id.slice(2)),
    ).toEqual(ids);
    const fed = runs.filter((x) => matchesFilters(x, f, { ignoreTimeRange: true }));
    expect(fed.map((x) => x.id)).toEqual(ids);
    const T0 = Date.UTC(2026, 0, 1, 12, 0);
    const buckets = bucketRuns(fed, { start: T0, end: T0 + 60 * 60_000, count: 6 });
    expect(buckets.reduce((n, b) => n + b.total, 0)).toBe(ids.length);
    const cost = ids.reduce((sum, id) => sum + runs.find((x) => x.id === id)!.costUsd, 0);
    expect(shownCost(runs, f).shown).toBeCloseTo(cost);
    expect(countByGroup(shownCost(runs, f).matching).succeeded).toBe(ids.length);
  });
});
