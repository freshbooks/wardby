import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialFilters } from "../state/filters";
import { hhmm } from "../format/time";
import { windowSpend } from "../format/spend";
import { TopBar } from "./TopBar";

describe("windowSpend", () => {
  it("sums costUsd over the runs", () => {
    expect(windowSpend([{ costUsd: 0.01 }, { costUsd: 0.2 }])).toBeCloseTo(0.21);
    expect(windowSpend([])).toBe(0);
  });
});

describe("TopBar spend", () => {
  it("shows the window total next to today's spend", () => {
    render(
      <TopBar
        servers={[]}
        selectedUrl={null}
        onSelectServer={vi.fn()}
        onAddServer={vi.fn()}
        onSignOut={vi.fn()}
        onRemoveServer={vi.fn()}
        live
        reconnecting={false}
        filters={{ ...initialFilters, window: "24h" }}
        onFiltersChange={vi.fn()}
        agents={[]}
        spend={{ todayUsd: 0, groups: [] }}
        windowSpendUsd={0.21}
        rangeRunCount={0}
        onClearRange={vi.fn()}
      />,
    );
    expect(screen.getByText(/24h \$0\.21/)).toBeInTheDocument();
    expect(screen.getByText(/Today \$0(?!\.)/)).toBeInTheDocument();
  });
});

describe("TopBar range chip", () => {
  const renderBar = (timeRange: { from: number; to: number } | null, onClearRange = vi.fn()) => {
    render(
      <TopBar
        servers={[]}
        selectedUrl={null}
        onSelectServer={vi.fn()}
        onAddServer={vi.fn()}
        onSignOut={vi.fn()}
        onRemoveServer={vi.fn()}
        live
        reconnecting={false}
        filters={{ ...initialFilters, timeRange }}
        onFiltersChange={vi.fn()}
        agents={[]}
        spend={null}
        windowSpendUsd={0}
        rangeRunCount={3}
        onClearRange={onClearRange}
      />,
    );
    return onClearRange;
  };

  it("is hidden without a range", () => {
    renderBar(null);
    expect(screen.queryByRole("button", { name: /clear time range/i })).toBeNull();
  });

  it("shows the span and run count, and the cross clears it", () => {
    const from = Date.UTC(2026, 0, 1, 12, 0);
    const to = Date.UTC(2026, 0, 1, 13, 0);
    const clear = renderBar({ from, to });
    expect(screen.getByText(`${hhmm(from)} → ${hhmm(to)} · 3 runs`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /clear time range/i }));
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe("TopBar truncated window total", () => {
  it("marks a lower bound with an explanatory title", () => {
    render(
      <TopBar
        servers={[]}
        selectedUrl={null}
        onSelectServer={vi.fn()}
        onAddServer={vi.fn()}
        onSignOut={vi.fn()}
        onRemoveServer={vi.fn()}
        live
        reconnecting={false}
        filters={{ ...initialFilters, window: "7d" }}
        onFiltersChange={vi.fn()}
        agents={[]}
        spend={{ todayUsd: 0, groups: [] }}
        windowSpendUsd={0.62}
        windowSpendTruncated
        rangeRunCount={0}
        onClearRange={vi.fn()}
      />,
    );
    const el = screen.getByText(/7d ≥\$0\.62/);
    expect(el.getAttribute("title")).toContain("Only the most recent 500 runs are loaded");
  });
});
