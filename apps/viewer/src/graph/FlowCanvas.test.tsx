import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GraphRun } from "../api/types";
import { initialFilters } from "../state/filters";
import { FlowCanvas } from "./FlowCanvas";

const viewportSpy = vi.hoisted(() => ({ setViewport: vi.fn() }));
vi.mock("@xyflow/react", async (orig) => {
  const m = await orig<typeof import("@xyflow/react")>();
  return {
    ...m,
    useReactFlow: () => ({ ...m.useReactFlow(), setViewport: viewportSpy.setViewport }),
  };
});

const layoutSpy = vi.hoisted(() => ({
  impl: async (g: { nodes: { id: string }[] }): Promise<Map<string, { x: number; y: number }>> =>
    new Map(g.nodes.map((n, i) => [n.id, { x: i * 300, y: 0 }])),
  calls: 0,
}));
vi.mock("./layout", () => ({
  layoutGraph: (g: { nodes: { id: string }[] }) => {
    layoutSpy.calls++;
    return layoutSpy.impl(g);
  },
}));

function makeRun(id: string, overrides: Partial<GraphRun> = {}): GraphRun {
  return {
    id,
    parentRunId: null,
    agentId: "a1",
    agentName: `agent-${id}`,
    agentKind: "native",
    status: "succeeded",
    trigger: { kind: "manual" },
    turns: 1,
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0.1,
    budgetUsd: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    heartbeatAt: null,
    outcomes: [],
    services: [],
    ...overrides,
  } as GraphRun;
}

describe("FlowCanvas", () => {
  const runs = [
    makeRun("one", { outcomes: [{ kind: "issue_comment", provider: "jira", issueKey: "WAR-1" }] }),
    makeRun("two", { startedAt: "2026-01-02T00:00:00.000Z" }),
  ];

  it("renders a trigger, run and outcome node per graph node", async () => {
    const { container } = render(
      <FlowCanvas runs={runs} filters={initialFilters} selectedId={null} onSelect={() => {}} />,
    );
    // 2 triggers + 2 runs + 1 outcome
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node")).toHaveLength(5));
    expect(screen.getByText("agent-one")).toBeInTheDocument();
    expect(screen.getByText("agent-two")).toBeInTheDocument();
  });

  it("selects a run on click but ignores trigger nodes", async () => {
    const onSelect = vi.fn();
    render(<FlowCanvas runs={runs} filters={initialFilters} selectedId={null} onSelect={onSelect} />);
    fireEvent.click(await screen.findByText("agent-one"));
    expect(onSelect).toHaveBeenCalledWith("one");
    onSelect.mockClear();
    fireEvent.click(screen.getAllByText("manual")[0]!);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("names nodes and selects a focused run node with Enter", async () => {
    const onSelect = vi.fn();
    render(<FlowCanvas runs={runs} filters={initialFilters} selectedId={null} onSelect={onSelect} />);
    const node = await screen.findByLabelText("agent-one, succeeded, run one");
    fireEvent.keyDown(node, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("one");
  });

  it("does not re-layout on data-only changes", async () => {
    layoutSpy.calls = 0;
    const props = { filters: initialFilters, selectedId: null, onSelect: () => {} };
    const { rerender } = render(<FlowCanvas runs={runs} {...props} />);
    await screen.findByText("agent-one");
    const before = layoutSpy.calls;
    rerender(
      <FlowCanvas runs={[makeRun("one", { costUsd: 0.9, outcomes: runs[0]!.outcomes }), runs[1]!]} {...props} />,
    );
    await screen.findByText("agent-one");
    expect(layoutSpy.calls).toBe(before);
  });

  it("keeps nodes visible through live updates without waiting for a re-measure", async () => {
    // The test ResizeObserver never fires, as when updates outpace React Flow's re-measure.
    const props = { filters: initialFilters, selectedId: null, onSelect: () => {} };
    const live = (costUsd: number) => [makeRun("one", { status: "running", finishedAt: null, costUsd }), runs[1]!];
    const { rerender, container } = render(<FlowCanvas runs={live(0.1)} {...props} />);
    await screen.findByText("agent-one");
    for (const cost of [0.2, 0.3, 0.4]) rerender(<FlowCanvas runs={live(cost)} {...props} />);
    const wrappers = [...container.querySelectorAll<HTMLElement>(".react-flow__node")];
    expect(wrappers.length).toBeGreaterThan(0);
    for (const w of wrappers) expect(w.style.visibility).toBe("visible");
  });

  it("drops a slower, earlier layout result", async () => {
    const resolvers: ((m: Map<string, { x: number; y: number }>) => void)[] = [];
    layoutSpy.impl = () => new Promise((res) => resolvers.push(res));
    const props = { filters: initialFilters, selectedId: null, onSelect: () => {} };
    const { rerender, container } = render(<FlowCanvas runs={[runs[1]!]} {...props} />);
    await waitFor(() => expect(resolvers).toHaveLength(1));
    rerender(<FlowCanvas runs={runs} {...props} />);
    await waitFor(() => expect(resolvers).toHaveLength(2));
    // Newer layout (5 nodes) resolves first, then the stale one (2 nodes).
    const ids = ["t:two", "r:two", "t:one", "r:one", "o:one:0"];
    await act(async () => resolvers[1]!(new Map(ids.map((id, i) => [id, { x: i * 300, y: 0 }]))));
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node")).toHaveLength(5));
    await act(async () => resolvers[0]!(new Map([["t:two", { x: 0, y: 0 }]])));
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(5);
    layoutSpy.impl = async (g) => new Map(g.nodes.map((n, i) => [n.id, { x: i * 300, y: 0 }]));
  });

  it("moves to the top-left at zoom 1 after a layout, not on live data changes", async () => {
    const props = { filters: initialFilters, selectedId: null, onSelect: () => {} };
    const { rerender } = render(<FlowCanvas runs={[runs[1]!]} {...props} />);
    await screen.findByText("agent-two");
    await waitFor(() => expect(viewportSpy.setViewport).toHaveBeenCalled());
    expect(viewportSpy.setViewport).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: 1 }));
    // Live update: same node set.
    viewportSpy.setViewport.mockClear();
    rerender(<FlowCanvas runs={[makeRun("two", { costUsd: 0.9, startedAt: runs[1]!.startedAt })]} {...props} />);
    await screen.findByText("agent-two");
    expect(viewportSpy.setViewport).not.toHaveBeenCalled();
    // Node set changes: new layout, back home.
    rerender(<FlowCanvas runs={runs} {...props} />);
    await screen.findByText("agent-one");
    await waitFor(() => expect(viewportSpy.setViewport).toHaveBeenCalledTimes(1));
    expect(viewportSpy.setViewport.mock.calls[0]![0]).toMatchObject({
      zoom: 1,
      x: expect.any(Number),
      y: expect.any(Number),
    });
  });
});
