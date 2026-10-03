import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialFilters } from "../state/filters";
import { TopBar, windowSpend } from "./TopBar";

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
      />,
    );
    expect(screen.getByText(/24h \$0\.21/)).toBeInTheDocument();
    expect(screen.getByText(/Today \$0\.00/)).toBeInTheDocument();
  });
});
