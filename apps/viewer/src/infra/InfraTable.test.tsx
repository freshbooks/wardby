import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { describe as describeCluster } from "./adapter";
import { gkeCluster, gkeInfo, RUN_SHA } from "./fixtures";
import { InfraTable } from "./InfraTable";

const model = describeCluster(gkeCluster, gkeInfo);

describe("InfraTable", () => {
  it("groups pods under ALWAYS ON, CODING RUNS and JOBS with the column headers", () => {
    render(<InfraTable model={model} selected={null} onSelect={vi.fn()} onOpenRun={vi.fn()} />);
    for (const h of ["ALWAYS ON", "CODING RUNS", "JOBS"]) expect(screen.getByText(h)).toBeInTheDocument();
    for (const c of ["Pod", "Containers", "Status", "CPU / Mem", "Age"]) {
      expect(screen.getByRole("columnheader", { name: c })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: /control-plane/ })).toBeInTheDocument();
    expect(screen.queryByText("unrelated-pod")).not.toBeInTheDocument();
  });

  it("selects a row on click and marks it aria-pressed", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<InfraTable model={model} selected={null} onSelect={onSelect} onOpenRun={vi.fn()} />);
    const row = screen.getByRole("button", { name: /headroom/ });
    expect(row).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("wardby-headroom-5b4a-klmno");
    rerender(
      <InfraTable model={model} selected="wardby-headroom-5b4a-klmno" onSelect={onSelect} onOpenRun={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /headroom/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows runtime beside status and the container names", () => {
    render(<InfraTable model={model} selected={null} onSelect={vi.fn()} onOpenRun={vi.fn()} />);
    const row = screen.getByRole("button", { name: /wardby-run-abc123/ });
    expect(within(row).getByText(/gVisor/)).toBeInTheDocument();
    expect(within(row).getByText("agent")).toBeInTheDocument();
  });

  it("opens the run from a coding-run row without selecting the pod", () => {
    const onOpenRun = vi.fn();
    const onSelect = vi.fn();
    render(<InfraTable model={model} selected={null} onSelect={onSelect} onOpenRun={onOpenRun} />);
    fireEvent.click(screen.getByRole("button", { name: "Open run" }));
    expect(onOpenRun).toHaveBeenCalledWith(RUN_SHA);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("filters rows by the filter box", () => {
    render(<InfraTable model={model} selected={null} onSelect={vi.fn()} onOpenRun={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter pods" }), { target: { value: "proxy" } });
    expect(screen.getByRole("button", { name: /coding-proxy/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /headroom/ })).not.toBeInTheDocument();
  });

  it("hides jobs that finished more than an hour ago", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    const old = new Map([["wardby-migrate", "2026-10-01T09:00:00Z"]]);
    const { rerender } = render(
      <InfraTable model={model} selected={null} onSelect={vi.fn()} onOpenRun={vi.fn()} jobFinishedAt={old} now={now} />,
    );
    expect(screen.queryByRole("button", { name: /wardby-migrate/ })).not.toBeInTheDocument();
    const recent = new Map([["wardby-migrate", "2026-10-01T11:30:00Z"]]);
    rerender(
      <InfraTable
        model={model}
        selected={null}
        onSelect={vi.fn()}
        onOpenRun={vi.fn()}
        jobFinishedAt={recent}
        now={now}
      />,
    );
    expect(screen.getByRole("button", { name: /wardby-migrate/ })).toBeInTheDocument();
  });
});
