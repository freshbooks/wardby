import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { GraphSnapshotSchema } from "./api-schema.js";
import { loadGraph, parseSince } from "./graph.js";

const db = createPrismaClient();
const suffix = randomUUID();
// Far-future clock: the DB is shared, so nothing else can outrank these runs in the newest-first cap.
const now = new Date("2030-01-01T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const MIN = 60_000;
const id = (name: string) => `graph-${name}-${suffix}`;
const ids = {
  A: id("agent-a"),
  C: id("agent-c"),
  R0: id("r0"),
  R1: id("r1"),
  R2: id("r2"),
  R3: id("r3"),
  R4: id("r4"),
};
const groupId = id("group");

describe.skipIf(!process.env.DATABASE_URL)("loadGraph (PostgreSQL)", () => {
  beforeAll(async () => {
    await db.agent.create({
      data: {
        id: ids.A,
        name: ids.A,
        systemPrompt: "x",
        model: "m",
        budgetUsd: 2,
        schedule: "0 */6 * * *",
        budgetGroup: { create: { id: groupId, name: groupId, dailyBudgetUsd: 10 } },
      },
    });
    await db.agent.create({
      data: { id: ids.C, name: ids.C, systemPrompt: "x", model: "m", budgetUsd: 1, kind: "coding" },
    });
    await db.run.create({
      data: { id: ids.R0, agentId: ids.A, status: "succeeded", startedAt: ago(180 * MIN), finishedAt: ago(170 * MIN) },
    });
    await db.run.create({
      data: {
        id: ids.R1,
        agentId: ids.A,
        trigger: "scheduled",
        status: "running",
        startedAt: ago(5 * MIN),
        costUsd: 0.4,
        turns: 3,
      },
    });
    await db.run.create({
      data: {
        id: ids.R2,
        agentId: ids.C,
        trigger: "subagent",
        parentRunId: ids.R1,
        status: "succeeded",
        startedAt: ago(4 * MIN),
        finishedAt: ago(1 * MIN),
        codingRun: {
          create: {
            task: "t",
            repository: "your-org/app",
            baseRef: "main",
            headRef: "wardby/x",
            provider: "codex",
            model: "m",
            timeoutSec: 60,
            protectedPaths: [],
            budgetReservedUsd: 0.5,
            result: {
              schemaVersion: 1,
              outcome: "pull_request_opened",
              repository: "your-org/app",
              baseRef: "main",
              headRef: "wardby/x",
              commitSha: "a".repeat(40),
              pullRequestUrl: "https://github.com/your-org/app/pull/7",
              pullRequestNumber: 7,
              summary: "done",
              tests: [],
              usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.1 },
            },
          },
        },
        serviceStatuses: { create: { name: "postgres", state: "ready", readyAt: ago(3 * MIN) } },
      },
    });
    await db.run.create({
      data: { id: ids.R3, agentId: ids.A, parentRunId: ids.R0, status: "running", startedAt: ago(2 * MIN) },
    });
    await db.run.create({
      data: {
        id: ids.R4,
        agentId: ids.A,
        trigger: "host_event",
        status: "succeeded",
        startedAt: ago(10 * MIN),
        issueStatus: { create: { provider: "jira", issueKey: "WMD-42", commentId: "c1" } },
      },
    });
  });

  afterAll(async () => {
    for (const r of [ids.R3, ids.R2, ids.R4, ids.R1, ids.R0]) await db.run.deleteMany({ where: { id: r } });
    await db.agent.deleteMany({ where: { id: { in: [ids.A, ids.C] } } });
    await db.budgetGroup.deleteMany({ where: { id: groupId } });
    await db.$disconnect();
  });

  const mine = (runs: { id: string }[]) => runs.filter((r) => Object.values(ids).includes(r.id));

  it("returns windowed runs plus ancestors and parses against the schema", async () => {
    const snap = await loadGraph(db, { since: ago(60 * MIN), limit: 500, now });
    expect(
      mine(snap.runs)
        .map((r) => r.id)
        .sort(),
    ).toEqual([ids.R0, ids.R1, ids.R2, ids.R3, ids.R4].sort());
    expect(() => GraphSnapshotSchema.parse(snap)).not.toThrow();
    const group = snap.spend.groups.find((g) => g.id === groupId);
    expect(group).toMatchObject({ dailyBudgetUsd: 10 });
    expect(group?.spentTodayUsd).toBeCloseTo(0.4);
  });

  it("maps triggers, outcomes and services", async () => {
    const snap = await loadGraph(db, { since: ago(60 * MIN), limit: 500, now });
    const by = (rid: string) => snap.runs.find((r) => r.id === rid)!;
    expect(by(ids.R1).trigger).toEqual({ kind: "scheduled", schedule: "0 */6 * * *" });
    expect(by(ids.R1).costUsd).toBe(0.4);
    expect(by(ids.R2).parentRunId).toBe(ids.R1);
    expect(by(ids.R2).outcomes).toEqual([
      {
        kind: "pull_request",
        provider: "github",
        repository: "your-org/app",
        number: 7,
        url: "https://github.com/your-org/app/pull/7",
        state: null,
      },
    ]);
    expect(by(ids.R2).services).toMatchObject([{ name: "postgres", state: "ready" }]);
    expect(by(ids.R4).trigger).toEqual({ kind: "issue", provider: "jira", issueKey: "WMD-42" });
    expect(by(ids.R4).outcomes).toEqual([{ kind: "issue_comment", provider: "jira", issueKey: "WMD-42" }]);
  });

  it("caps the window but never its ancestors", async () => {
    const snap = await loadGraph(db, { since: ago(60 * MIN), limit: 2, now });
    expect(snap.truncated).toBe(true);
    expect(
      mine(snap.runs)
        .map((r) => r.id)
        .sort(),
    ).toEqual([ids.R0, ids.R3, ids.R2, ids.R1].sort());
  });

  it("parses since values", () => {
    expect(parseSince("15m", now)).toEqual(ago(15 * MIN));
    expect(parseSince("7d", now)).toEqual(new Date(now.getTime() - 7 * 86_400_000));
    expect(parseSince("2030-01-01T11:00:00Z", now)).toEqual(ago(60 * MIN));
    expect(parseSince(null, now)).toEqual(ago(60 * MIN));
    expect(() => parseSince("5y", now)).toThrow();
  });
});
