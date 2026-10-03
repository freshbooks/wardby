import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphRun } from "../api/types";
import { RunNode } from "./nodes/RunNode";
import type { NodeProps } from "@xyflow/react";
import { ReactFlowProvider } from "@xyflow/react";

function run(overrides: Partial<GraphRun>): GraphRun {
  return {
    id: "run_abcdef",
    parentRunId: null,
    agentId: "a",
    agentName: "b",
    agentKind: "native",
    status: "running",
    trigger: { kind: "manual" },
    turns: 1,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    budgetUsd: 1,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    heartbeatAt: null,
    outcomes: [],
    services: [],
    ...overrides,
  } as GraphRun;
}
const node = (r: GraphRun) => (
  <RunNode {...({ data: { kind: "run", run: r, selected: false } } as unknown as NodeProps)} />
);

describe("shared clock and fade", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("uses one interval for several running nodes and stops it on unmount", () => {
    const set = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = render(
      <ReactFlowProvider>
        {node(run({ id: "r1" }))}
        {node(run({ id: "r2" }))}
      </ReactFlowProvider>,
    );
    expect(set).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    unmount();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fades a succeeded run 60 s after it finished and cleans up", () => {
    const finishedAt = new Date().toISOString();
    const { container, unmount } = render(
      <ReactFlowProvider>{node(run({ status: "succeeded", finishedAt }))}</ReactFlowProvider>,
    );
    const el = () => container.querySelector(".flow-node")!;
    expect(el()).not.toHaveClass("faded");
    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(el()).not.toHaveClass("faded");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(el()).toHaveClass("faded");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders a zero-budget run without NaN", () => {
    const { container } = render(<ReactFlowProvider>{node(run({ budgetUsd: 0, costUsd: 0.5 }))}</ReactFlowProvider>);
    expect(container.innerHTML).not.toContain("NaN");
  });
});
