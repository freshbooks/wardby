import { render, screen } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type { GraphRun, Outcome } from "../../api/types";
import { OutcomeNode } from "./OutcomeNode";
import { RunNode } from "./RunNode";
import { TriggerNode } from "./TriggerNode";

function makeRun(overrides: Partial<GraphRun> = {}): GraphRun {
  return {
    id: "run_abcdef123456",
    parentRunId: null,
    agentId: "a1",
    agentName: "builder",
    agentKind: "coding",
    status: "running",
    trigger: { kind: "manual" },
    turns: 6,
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0.414,
    budgetUsd: 2,
    startedAt: new Date(Date.now() - 134_000).toISOString(),
    finishedAt: null,
    heartbeatAt: null,
    outcomes: [],
    services: [],
    ...overrides,
  } as GraphRun;
}

// Only `data` matters to the custom nodes; the rest of NodeProps is React Flow plumbing.
const props = (data: unknown) => ({ data }) as unknown as NodeProps;
const wrap = (ui: React.ReactElement) => render(<ReactFlowProvider>{ui}</ReactFlowProvider>);

describe("RunNode", () => {
  it("shows glyph, agent, id, turn, cost and service chips for a coding run", () => {
    const run = makeRun({
      services: [
        {
          name: "postgres",
          state: "probing",
          attempts: 3,
          reason: null,
          readyAt: null,
          failedAt: null,
          createdAt: "x",
        },
        { name: "redis", state: "ready", attempts: null, reason: null, readyAt: "x", failedAt: null, createdAt: "x" },
        {
          name: "minio",
          state: "pending",
          attempts: null,
          reason: null,
          readyAt: null,
          failedAt: null,
          createdAt: "x",
        },
        { name: "kafka", state: "failed", attempts: null, reason: "oom", readyAt: null, failedAt: "x", createdAt: "x" },
      ],
    });
    wrap(<RunNode {...props({ kind: "run", run, selected: false })} />);
    expect(screen.getByText("builder")).toBeInTheDocument();
    expect(screen.getByText("◉")).toBeInTheDocument();
    expect(screen.getByText(/123456/)).toBeInTheDocument();
    expect(screen.getByText(/turn 6 · \$0\.41/)).toBeInTheDocument();
    expect(screen.getByText(/postgres/)).toHaveTextContent("◐ probing 3");
    expect(screen.getByText(/redis/)).toHaveTextContent("● ready");
    expect(screen.getByText(/minio/)).toHaveTextContent("○ pending");
    expect(screen.getByText(/kafka/)).toHaveTextContent("✗ failed (oom)");
    expect(screen.getByText(/2m 1\ds/)).toBeInTheDocument();
  });

  it("marks failed-family runs and selection", () => {
    const run = makeRun({ status: "budget_exhausted", finishedAt: new Date().toISOString() });
    const { container } = wrap(<RunNode {...props({ kind: "run", run, selected: true })} />);
    expect(screen.getByText("✗")).toBeInTheDocument();
    const node = container.querySelector(".flow-node.run") as HTMLElement;
    expect(node).toHaveClass("failed");
    expect(node).toHaveClass("selected");
  });
});

describe("TriggerNode / OutcomeNode", () => {
  it("renders the trigger label", () => {
    wrap(<TriggerNode {...props({ kind: "trigger", trigger: { kind: "manual" }, label: "⏰ 0 * * * *" })} />);
    expect(screen.getByText("⏰ 0 * * * *")).toBeInTheDocument();
  });

  it("renders a pull request outcome", () => {
    const outcome: Outcome = {
      kind: "pull_request",
      provider: "github",
      repository: "your-org/app",
      number: 212,
      url: "https://example.test/pr/212",
      state: "open",
    };
    wrap(<OutcomeNode {...props({ kind: "outcome", outcome })} />);
    expect(screen.getByText("⎇ your-org/app#212")).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
  });
});
