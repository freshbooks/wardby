import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GraphRun } from "../api/types";
import { initialFilters } from "../state/filters";
import { BottomBar } from "./BottomBar";

const r = (id: string, agentName: string, costUsd: number, status = "succeeded") =>
  ({
    id,
    agentId: agentName,
    agentName,
    costUsd,
    parentRunId: null,
    status,
    startedAt: "2026-01-01T10:00:00Z",
  }) as GraphRun;
const runs = [r("a", "jira-smoke", 0.09), r("b", "builder", 0.02, "failed")];

describe("BottomBar cost", () => {
  it("shows only the total when nothing is narrowed", () => {
    render(<BottomBar runs={runs} filters={initialFilters} ticker={[]} window="24h" />);
    expect(screen.getByText("$0.11 (24h)")).toBeTruthy();
    expect(screen.queryByText(/shown of/)).toBeNull();
  });

  it("shows shown-of-total with a per-agent tooltip when filtered", () => {
    const f = { ...initialFilters, statuses: new Set(["succeeded" as const]) };
    render(<BottomBar runs={runs} filters={f} ticker={[]} window="24h" />);
    const el = screen.getByText("$0.09 shown of $0.11 (24h)");
    expect(el.getAttribute("title")).toBe("jira-smoke $0.09\n$0.090000 shown of $0.110000");
    expect(el.getAttribute("aria-description")).toBe("jira-smoke $0.09");
    expect(screen.getByText(/0 failed/)).toBeTruthy();
  });

  it("marks a truncated window total as a lower bound", () => {
    render(<BottomBar runs={runs} filters={initialFilters} ticker={[]} window="7d" truncated />);
    const el = screen.getByText("≥$0.11 (7d)");
    expect(el.getAttribute("title")).toContain("Only the most recent 500 runs are loaded");
  });

  it("is narrowed by run count, not cost equality", () => {
    const free = [r("a", "x", 0), r("b", "y", 0, "failed")];
    const f = { ...initialFilters, statuses: new Set(["succeeded" as const]) };
    render(<BottomBar runs={free} filters={f} ticker={[]} window="1h" />);
    expect(screen.getByText("$0 shown of $0 (1h)")).toBeTruthy();
  });
});

describe("BottomBar ticker", () => {
  it("shows only the latest event", () => {
    const ticker = [
      { at: Date.parse("2026-01-01T10:00:02Z"), text: "hello abc123 succeeded · turn 2 · $0.0029" },
      { at: Date.parse("2026-01-01T10:00:01Z"), text: "hello abc123 running · turn 1 · $0.0010" },
    ];
    render(<BottomBar runs={runs} filters={initialFilters} ticker={ticker} window="1h" />);
    const latest = screen.getByRole("status", { name: "Latest event" });
    expect(latest.textContent).toContain("hello abc123 succeeded");
    expect(screen.queryByText(/running · turn 1/)).toBeNull();
  });

  it("shows nothing before the first event", () => {
    render(<BottomBar runs={runs} filters={initialFilters} ticker={[]} window="1h" />);
    expect(screen.queryByRole("status", { name: "Latest event" })).toBeNull();
  });
});
