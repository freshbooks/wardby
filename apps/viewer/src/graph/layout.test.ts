import { describe, expect, it } from "vitest";
import type { GraphRun } from "../api/types";
import { buildGraph } from "./build";
import { layoutGraph } from "./layout";
import { OUTCOME_SIZE, RUN_WIDTH, TRIGGER_SIZE, runHeight } from "./sizes";

function run(id: string, parentRunId: string | null, startedAt: string): GraphRun {
  return {
    id,
    parentRunId,
    agentId: "a",
    agentName: "A",
    agentKind: "native",
    status: "running",
    trigger: { kind: "manual" },
    turns: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    budgetUsd: 1,
    startedAt,
    finishedAt: null,
    heartbeatAt: null,
    outcomes: [{ kind: "issue_comment", provider: "jira", issueKey: "K-1" }],
    services: [],
  } as GraphRun;
}

const graph = buildGraph(
  [
    run("p", null, "2026-01-01T00:00:00.000Z"),
    run("c", "p", "2026-01-01T00:01:00.000Z"),
    run("q", null, "2026-01-02T00:00:00.000Z"),
  ],
  { statuses: null, agentIds: null, search: "" },
  null,
);

describe("layoutGraph", () => {
  it("positions every node, children right of parents", async () => {
    const pos = await layoutGraph(graph);
    for (const n of graph.nodes) expect(pos.get(n.id)).toBeDefined();
    expect(pos.get("r:c")!.x).toBeGreaterThan(pos.get("r:p")!.x);
    expect(pos.get("r:p")!.x).toBeGreaterThan(pos.get("t:p")!.x);
    expect(pos.get("o:p:0")!.x).toBeGreaterThan(pos.get("r:p")!.x);
  });

  it("stacks run trees vertically, newest first, without overlap", async () => {
    const pos = await layoutGraph(graph);
    const boxes = new Map<string, { top: number; bottom: number; left: number }>();
    for (const n of graph.nodes) {
      const p = pos.get(n.id)!;
      const h =
        n.data.kind === "trigger"
          ? TRIGGER_SIZE.height
          : n.data.kind === "outcome"
            ? OUTCOME_SIZE.height
            : runHeight(n.data.run.services.length);
      const root = n.id.startsWith("t:") ? n.id.slice(2) : n.id.startsWith("r:") ? n.id.slice(2) : n.id.split(":")[1];
      const tree = root === "c" ? "p" : root;
      const b = boxes.get(tree) ?? { top: Infinity, bottom: -Infinity, left: Infinity };
      boxes.set(tree, { top: Math.min(b.top, p.y), bottom: Math.max(b.bottom, p.y + h), left: Math.min(b.left, p.x) });
    }
    const q = boxes.get("q")!;
    const p = boxes.get("p")!;
    expect(RUN_WIDTH).toBe(240);
    expect(q.left).toBe(0);
    expect(p.left).toBe(0);
    expect(q.top).toBeLessThan(p.top);
    expect(q.bottom).toBeLessThanOrEqual(p.top);
  });

  it("is deterministic", async () => {
    const a = await layoutGraph(graph);
    const b = await layoutGraph(graph);
    expect([...b.entries()]).toEqual([...a.entries()]);
  });

  it("handles an empty graph", async () => {
    expect((await layoutGraph({ nodes: [], edges: [] })).size).toBe(0);
  });
});
