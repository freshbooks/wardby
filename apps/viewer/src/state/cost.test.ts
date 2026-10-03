import { describe, expect, it } from "vitest";
import type { GraphRun } from "../api/types";
import { breakdownText, shownCost } from "./cost";
import { initialFilters } from "./filters";

const r = (id: string, agentName: string, costUsd: number, parentRunId: string | null = null, status = "succeeded") =>
  ({ id, agentId: agentName, agentName, costUsd, parentRunId, status, startedAt: "2026-01-01T10:00:00Z" }) as GraphRun;

describe("shownCost", () => {
  const runs = [r("p", "parent", 1), r("c", "child", 0.5, "p", "failed"), r("o", "child", 0.25)];

  it("sums matching runs per agent, sorted by cost desc", () => {
    const out = shownCost(runs, initialFilters);
    expect(out.shown).toBeCloseTo(1.75);
    expect(out.byAgent.map((a) => a.agentName)).toEqual(["parent", "child"]);
  });

  it("excludes context-only ancestors", () => {
    const out = shownCost(runs, { ...initialFilters, statuses: new Set(["failed"]) });
    expect(out.shown).toBeCloseTo(0.5);
    expect(out.matching.map((x) => x.id)).toEqual(["c"]);
  });
});

describe("breakdownText", () => {
  it("caps the breakdown at 8 agents", () => {
    const by = Array.from({ length: 10 }, (_, i) => ({ agentName: `a${i}`, costUsd: 1 }));
    expect(breakdownText(by).endsWith("· +2 more")).toBe(true);
    expect(
      breakdownText([
        { agentName: "x", costUsd: 0.09 },
        { agentName: "y", costUsd: 0.02 },
      ]),
    ).toBe("x $0.09 · y $0.02");
  });
});
