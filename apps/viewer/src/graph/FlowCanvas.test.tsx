import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GraphRun } from "../api/types";
import { initialFilters } from "../state/filters";
import { FlowCanvas } from "./FlowCanvas";

vi.mock("./layout", () => ({
  layoutGraph: async (g: { nodes: { id: string }[] }) => new Map(g.nodes.map((n, i) => [n.id, { x: i * 300, y: 0 }])),
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
});
