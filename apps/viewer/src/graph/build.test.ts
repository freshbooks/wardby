import { describe, expect, it } from "vitest";
import type { GraphRun, RunStatus } from "../api/types";
import { buildGraph, type Filters } from "./build";

function makeRun(id: string, overrides: Partial<GraphRun> = {}): GraphRun {
  return {
    id,
    parentRunId: null,
    agentId: "agent-1",
    agentName: "Triage",
    agentKind: "native",
    status: "succeeded",
    trigger: { kind: "manual" },
    turns: 1,
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
    budgetUsd: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    heartbeatAt: null,
    outcomes: [],
    services: [],
    ...overrides,
  } as GraphRun;
}

const all: Filters = { statuses: null, agentIds: null, search: "" };

const runs: GraphRun[] = [
  makeRun("a", {
    startedAt: "2026-01-01T00:00:00.000Z",
    trigger: { kind: "scheduled", schedule: "0 * * * *" },
  }),
  makeRun("b", {
    startedAt: "2026-01-02T00:00:00.000Z",
    agentId: "agent-2",
    agentName: "Coder",
    trigger: { kind: "issue", provider: "jira", issueKey: "WAR-7" },
    outcomes: [
      {
        kind: "pull_request",
        provider: "github",
        repository: "your-org/your-repo",
        number: 3,
        url: "https://example.test/pr/3",
        state: "open",
      },
      { kind: "issue_comment", provider: "jira", issueKey: "WAR-7" },
    ],
  }),
  makeRun("c", {
    parentRunId: "b",
    status: "running",
    startedAt: "2026-01-02T00:05:00.000Z",
    trigger: { kind: "subagent" },
  }),
  makeRun("d", {
    parentRunId: "b",
    status: "failed",
    startedAt: "2026-01-02T00:01:00.000Z",
    trigger: { kind: "subagent" },
  }),
];

describe("buildGraph", () => {
  it("builds trigger, run and outcome nodes with edges", () => {
    const g = buildGraph(runs, all, null);
    expect(g.nodes.map((n) => n.id)).toEqual(["t:b", "r:b", "o:b:0", "o:b:1", "r:d", "r:c", "t:a", "r:a"]);
    expect(g.nodes.find((n) => n.id === "t:a")?.data).toMatchObject({
      kind: "trigger",
      label: "⏰ 0 * * * *",
    });
    expect(g.nodes.find((n) => n.id === "t:b")?.data).toMatchObject({
      label: "◆ jira WAR-7",
    });
    expect(g.edges.map((e) => [e.source, e.target])).toEqual([
      ["t:b", "r:b"],
      ["r:b", "o:b:0"],
      ["r:b", "o:b:1"],
      ["r:b", "r:d"],
      ["r:b", "r:c"],
      ["t:a", "r:a"],
    ]);
  });

  it("treats a run whose parent is missing as a sub-agent root", () => {
    const g = buildGraph([makeRun("x", { parentRunId: "gone", trigger: { kind: "subagent" } })], all, null);
    expect(g.nodes[0]).toMatchObject({ id: "t:x", data: { label: "sub-agent" } });
  });

  it("labels code host triggers", () => {
    const g = buildGraph(
      [
        makeRun("x", {
          trigger: { kind: "code_host", provider: "github", repository: "o/r", number: 4, event: "review" },
        }),
      ],
      all,
      null,
    );
    expect(g.nodes[0].data).toMatchObject({ label: "⎇ o/r#4 review" });
  });

  it("marks the selected run", () => {
    const g = buildGraph(runs, all, "c");
    const sel = g.nodes.filter((n) => n.data.kind === "run" && n.data.selected).map((n) => n.id);
    expect(sel).toEqual(["r:c"]);
  });

  it("keeps ancestors of a status-matching child", () => {
    const g = buildGraph(runs, { ...all, statuses: new Set<RunStatus>(["failed"]) }, null);
    expect(g.nodes.map((n) => n.id)).toEqual(["t:b", "r:b", "o:b:0", "o:b:1", "r:d"]);
  });

  it("filters by agent id", () => {
    const g = buildGraph(runs, { ...all, agentIds: new Set(["agent-1"]) }, null);
    expect(g.nodes.map((n) => n.id)).toEqual(["t:b", "r:b", "o:b:0", "o:b:1", "r:d", "r:c", "t:a", "r:a"]);
  });

  it("searches by issue key in outcomes, case-insensitively", () => {
    const g = buildGraph(runs, { ...all, search: "war-7" }, null);
    expect(g.nodes.map((n) => n.id)).toEqual(["t:b", "r:b", "o:b:0", "o:b:1"]);
  });

  it("searches agent name, run id and trigger label", () => {
    expect(buildGraph(runs, { ...all, search: "coder" }, null).nodes.some((n) => n.id === "r:a")).toBe(false);
    expect(buildGraph(runs, { ...all, search: "0 * * *" }, null).nodes.map((n) => n.id)).toEqual(["t:a", "r:a"]);
    expect(buildGraph(runs, { ...all, search: "d" }, null).nodes.some((n) => n.id === "r:d")).toBe(true);
  });

  it("animates edges into running runs and out of running runs to outcomes", () => {
    const g = buildGraph(
      [
        makeRun("p", {
          status: "pending",
          outcomes: [{ kind: "issue_comment", provider: "jira", issueKey: "K-1" }],
        }),
        makeRun("q", { parentRunId: "p", status: "running" }),
        makeRun("s", { parentRunId: "p", status: "succeeded", startedAt: "2026-01-01T00:00:01.000Z" }),
      ],
      all,
      null,
    );
    const animated = Object.fromEntries(g.edges.map((e) => [e.id, e.animated]));
    expect(animated["t:p->r:p"]).toBe(true);
    expect(animated["r:p->o:p:0"]).toBe(true);
    expect(animated["r:p->r:q"]).toBe(true);
    expect(animated["r:p->r:s"]).toBe(false);
  });

  it("is deterministic and orders ties by id", () => {
    const same = [makeRun("z"), makeRun("m"), makeRun("n", { parentRunId: "z" }), makeRun("k", { parentRunId: "z" })];
    const a = buildGraph(same, all, null);
    const b = buildGraph([...same].reverse(), all, null);
    expect(b).toEqual(a);
    expect(a.nodes.map((n) => n.id)).toEqual(["t:m", "r:m", "t:z", "r:z", "r:k", "r:n"]);
  });
});

describe("buildGraph timeRange", () => {
  it("keeps runs started in range and their ancestors", () => {
    const rs = [
      makeRun("root", { startedAt: "2026-01-01T10:00:00.000Z" }),
      makeRun("child", { parentRunId: "root", startedAt: "2026-01-01T12:00:00.000Z" }),
      makeRun("other", { startedAt: "2026-01-01T15:00:00.000Z" }),
    ];
    const timeRange = { from: Date.parse("2026-01-01T11:00:00.000Z"), to: Date.parse("2026-01-01T13:00:00.000Z") };
    const ids = buildGraph(rs, { ...all, timeRange }, null)
      .nodes.filter((n) => n.type === "run")
      .map((n) => n.id);
    expect(ids.sort()).toEqual(["r:child", "r:root"]);
  });
});
