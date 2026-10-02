import { describe, expect, it } from "vitest";
import type { GraphRun } from "../api/types";
import { buildGraph } from "./build";
import { layoutGraph } from "./layout";

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

  it("is deterministic", async () => {
    const a = await layoutGraph(graph);
    const b = await layoutGraph(graph);
    expect([...b.entries()]).toEqual([...a.entries()]);
  });

  it("handles an empty graph", async () => {
    expect((await layoutGraph({ nodes: [], edges: [] })).size).toBe(0);
  });
});
