import { describe, expect, it } from "vitest";
import type { GraphRun } from "../api/types";
import { initialFilters, type StatusGroup } from "../state/filters";
import { buildGraph } from "./build";

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

const all = initialFilters;

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
        at: null,
      },
      { kind: "issue_comment", provider: "jira", issueKey: "WAR-7", at: null },
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
    const g = buildGraph(runs, { ...all, statuses: new Set<StatusGroup>(["failed"]) }, null);
    expect(g.nodes.map((n) => n.id)).toEqual(["t:b", "r:b", "o:b:0", "o:b:1", "r:d"]);
  });

  it("filters by agent id", () => {
    const g = buildGraph(runs, { ...all, agents: new Set(["agent-1"]) }, null);
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
          outcomes: [{ kind: "issue_comment", provider: "jira", issueKey: "K-1", at: null }],
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

describe("buildGraph pull-request chains", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 9, 6, 10, n)).toISOString();
  const prOut = {
    kind: "pull_request",
    provider: "github",
    repository: "o/r",
    number: 6,
    url: "https://github.com/o/r/pull/6",
    state: "open",
    at: null,
  } as const;
  const checkOut = (completed: boolean) =>
    ({ kind: "check", provider: "github", repository: "o/r", number: 6, completed, at: null }) as const;
  const review = { kind: "code_host", provider: "github", repository: "o/r", number: 6, event: "review" } as const;
  const loop = [
    makeRun("build", { startedAt: at(0), outcomes: [prOut] }),
    makeRun("rev1", { startedAt: at(5), trigger: review, outcomes: [checkOut(false)] }),
    makeRun("fix", { startedAt: at(8), trigger: { kind: "webhook" } }),
    makeRun("fixbuild", { parentRunId: "fix", startedAt: at(9), outcomes: [prOut] }),
    makeRun("rev2", { startedAt: at(15), trigger: review, outcomes: [checkOut(true)], status: "running" }),
  ];

  it("joins the runs into one chain with labelled edges and one trigger", () => {
    const g = buildGraph(loop, all, null);
    expect(g.nodes.filter((n) => n.type === "trigger").map((n) => n.id)).toEqual(["t:build"]);
    const chain = g.edges.filter((e) => e.label).map(({ source, target, label }) => ({ source, target, label }));
    expect(chain).toEqual([
      { source: "o:build:0", target: "r:rev1", label: "review" },
      { source: "o:rev1:0", target: "r:fix", label: "fix" },
      { source: "o:fixbuild:0", target: "r:rev2", label: "review" },
    ]);
    // The running re-review's link is animated like any live edge.
    expect(g.edges.find((e) => e.target === "r:rev2" && e.label)!.animated).toBe(true);
  });

  it("draws no chain when no PR box is in view", () => {
    // Only the reviews are shown (failed or running); every run that opened or pushed to the PR is filtered out.
    const reviewsOnly = { ...all, statuses: new Set<StatusGroup>(["running", "failed"]) };
    const shown = loop.map((r) => (r.id === "rev1" ? { ...r, status: "failed" as const } : r));
    const g = buildGraph(shown, reviewsOnly, null);
    expect(g.nodes.some((n) => n.id === "r:build" || n.id === "r:fixbuild")).toBe(false);
    expect(g.edges.some((e) => e.label)).toBe(false);
    expect(g.nodes.some((n) => n.id === "t:rev1")).toBe(true);
  });

  it("anchors on the earliest PR box in view when the opener is filtered out", () => {
    const hideOpener = { ...all, statuses: new Set<StatusGroup>(["running", "failed"]) };
    const shown = loop.map((r) => (r.id === "build" ? r : r.id === "rev2" ? r : { ...r, status: "failed" as const }));
    const g = buildGraph(shown, hideOpener, null);
    expect(g.edges.filter((e) => e.label).map((e) => [e.source, e.target])).toEqual([["o:fixbuild:0", "r:rev2"]]);
  });

  it("still marks a selected run inside the chain", () => {
    const g = buildGraph(loop, all, "rev1");
    const node = g.nodes.find((n) => n.id === "r:rev1")!;
    expect(node.data).toMatchObject({ kind: "run", selected: true });
  });
});
