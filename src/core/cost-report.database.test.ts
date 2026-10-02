/**
 * costReport's SQL against real PostgreSQL: grouping, the frozen parent,
 * visibility (owned agents or triggered runs only), unattributed spend and
 * truncation. Every fixture row is suffixed and the work items use their own
 * provider, so other tests' rows in the shared database can't leak in.
 * Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "./db.js";
import { costReport, type CostReportQuery } from "./cost-report.js";

describe.skipIf(!process.env.DATABASE_URL)("costReport (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID();
  const id = (name: string) => `costrpt-${name}-${suffix}`;
  const provider = id("provider");
  const tag = Math.floor(Math.random() * 1e9);
  const [E1, E2, I1, I2] = ["E1", "E2", "I1", "I2"].map((k) => `CR${tag}-${k}`);
  const aliceId = id("alice");
  const bobId = id("bob");
  const A = id("agent-a");
  const B = id("agent-b");
  const [r1, r2, r3, r4, r5, r6, r7] = ["r1", "r2", "r3", "r4", "r5", "r6", "r7"].map(id);
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const alice = { ownedAgentIds: [A], principalId: aliceId };
  const itemIds = new Map<string, string>();

  const q = (partial: Partial<CostReportQuery>): CostReportQuery => ({
    groupBy: "issue",
    from: new Date(now - 30 * 24 * HOUR),
    to: new Date(now + 60 * 1000),
    limit: 25,
    provider,
    ...partial,
  });

  async function addRun(
    runId: string,
    agentId: string,
    costUsd: number,
    opts: { startedAt?: Date; status?: "running" | "succeeded"; triggeredById?: string | null } = {},
  ) {
    await db.run.create({
      data: {
        id: runId,
        agentId,
        costUsd,
        status: opts.status ?? "succeeded",
        startedAt: opts.startedAt ?? new Date(now - HOUR),
        triggeredById: opts.triggeredById ?? null,
      },
    });
  }
  const attribute = (runId: string, item: string, source: string, parentKeyAtRun: string | null) =>
    db.runAttribution.create({ data: { runId, workItemId: itemIds.get(item)!, source, parentKeyAtRun } });
  const usage = (runId: string, model: string, costUsd: number, t: [number, number, number, number] = [0, 0, 0, 0]) =>
    db.runModelUsage.create({
      data: {
        runId,
        model,
        costUsd,
        freshInputTokens: t[0],
        cachedInputTokens: t[1],
        cacheWriteTokens: t[2],
        outputTokens: t[3],
      },
    });

  beforeAll(async () => {
    for (const p of [aliceId, bobId]) await db.principal.create({ data: { id: p, subject: p } });
    for (const [agentId, ownerId] of [
      [A, aliceId],
      [B, bobId],
    ]) {
      await db.agent.create({
        data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 100, ownerId },
      });
    }
    const items: Array<[string, Record<string, string>]> = [
      [E1, { title: "Epic one", type: "epic" }],
      [E2, { title: "Epic two", type: "epic" }],
      [I1, { title: "New title", type: "story", parentKey: E2, parentKind: "epic" }],
      [I2, { title: "Second", type: "story", parentKey: E1, parentKind: "epic" }],
    ];
    for (const [key, extra] of items) {
      const w = await db.workItem.create({ data: { provider, key, scopeKey: `CR${tag}`, ...extra } });
      itemIds.set(key, w.id);
    }
    await addRun(r1, A, 1.0, { startedAt: new Date(now - 3 * HOUR) });
    await attribute(r1, I1, "issue_event", E1);
    await usage(r1, "m1", 1.0, [100, 900, 10, 50]);
    await addRun(r2, A, 0.5, { startedAt: new Date(now - 2 * HOUR) });
    await attribute(r2, I1, "inherited", E2);
    await usage(r2, "m2", 0.5, [10, 0, 0, 5]);
    await addRun(r3, A, 2.0);
    await attribute(r3, I2, "linked_pr", E1);
    await usage(r3, "m1", 2.0);
    await addRun(r4, B, 7.0, { triggeredById: null });
    await attribute(r4, I1, "explicit", E2);
    await usage(r4, "m1", 7.0);
    await addRun(r5, A, 0.25);
    await addRun(r6, A, 9.0, { startedAt: new Date(now - 60 * 24 * HOUR) });
    await attribute(r6, I1, "issue_event", E2);
    await addRun(r7, A, 0.1, { status: "running" });
    await attribute(r7, I2, "issue_event", E1);
  });

  afterAll(async () => {
    await db.run.deleteMany({ where: { agentId: { in: [A, B] } } });
    await db.workItem.deleteMany({ where: { provider } });
    await db.agent.deleteMany({ where: { id: { in: [A, B] } } });
    await db.principal.deleteMany({ where: { id: { in: [aliceId, bobId] } } });
    await db.$disconnect();
  });

  it("groups by issue with current titles, by-kind tokens, models and sources", async () => {
    const r = await costReport(db, q({ groupBy: "issue" }), alice);
    expect(r.currency).toBe("USD");
    expect(r.rows.map((x) => [x.key, x.costUsd])).toEqual([
      [I2, "2.1"],
      [I1, "1.5"],
    ]); // desc by cost; r4 invisible, r6 outside
    const i1 = r.rows.find((x) => x.key === I1)!;
    expect(i1).toMatchObject({ title: "New title", kind: "story", provider, runs: 2, inProgressRuns: 0 });
    expect(i1.tokens).toEqual({ freshInput: 110, cachedInput: 900, cacheWrite: 10, output: 55 });
    expect(i1.byModel.map((m) => m.model)).toEqual(["m1", "m2"]);
    expect(i1.byModel[0]).toEqual({
      model: "m1",
      costUsd: "1",
      tokens: { freshInput: 100, cachedInput: 900, cacheWrite: 10, output: 50 },
    });
    expect(i1.bySource).toMatchObject({ issue_event: "1", inherited: "0.5", linked_pr: "0", explicit: "0" });
    expect(i1.firstRunAt).toBe(new Date(now - 3 * HOUR).toISOString());
    expect(i1.lastRunAt).toBe(new Date(now - 2 * HOUR).toISOString());
    expect(r.rows.find((x) => x.key === I2)!.inProgressRuns).toBe(1);
    expect(r.totals).toEqual({
      runs: 4,
      costUsd: "3.6",
      tokens: { freshInput: 110, cachedInput: 900, cacheWrite: 10, output: 55 },
    });
  });

  it("groups by the parent frozen at dispatch, not the current parent", async () => {
    const r = await costReport(db, q({ groupBy: "parent" }), alice);
    expect(Object.fromEntries(r.rows.map((x) => [x.key, x.costUsd]))).toEqual({ [E1]: "3.1", [E2]: "0.5" });
    expect(r.rows.find((x) => x.key === E1)).toMatchObject({ title: "Epic one", kind: "epic" });
  });

  it("buckets runs with no frozen parent under (no parent), untitled and kind-less", async () => {
    const r9 = id("r9");
    await addRun(r9, A, 0.05);
    await attribute(r9, I1, "explicit", null);
    try {
      const r = await costReport(db, q({ groupBy: "parent" }), alice);
      expect(r.rows.find((x) => x.key === "(no parent)")).toMatchObject({
        title: null,
        kind: null,
        runs: 1,
        costUsd: "0.05",
      });
    } finally {
      await db.run.deleteMany({ where: { id: r9 } });
    }
  });

  it("filters compose: cards in an epic", async () => {
    const r = await costReport(db, q({ groupBy: "issue", parentKey: E1 }), alice);
    expect(r.rows.map((x) => x.key).sort()).toEqual([I1, I2].sort());
  });

  it("never counts invisible agents' runs, in rows or totals", async () => {
    const r = await costReport(db, q({ groupBy: "agent" }), alice);
    expect(r.rows.map((x) => x.key)).toEqual([A]);
    expect(r.rows[0]).toMatchObject({ title: A, kind: "agent" });
    expect(r.totals.costUsd).toBe("3.6");
  });

  it("an operator (null visibility) sees everything", async () => {
    const r = await costReport(db, q({ groupBy: "issue", issueKey: I1 }), null);
    expect(r.rows[0].costUsd).toBe("8.5");
  });

  it("a triggerer sees runs they triggered on an agent they don't own", async () => {
    const r8 = id("r8");
    await addRun(r8, B, 0.3, { triggeredById: aliceId });
    await attribute(r8, I1, "explicit", E2);
    try {
      const r = await costReport(db, q({ groupBy: "run", issueKey: I1 }), alice);
      expect(r.rows.map((x) => x.key).sort()).toEqual([r1, r2, r8].sort()); // r4 (bob's, untriggered) still hidden
      const onlyTriggered = await costReport(db, q({ groupBy: "issue" }), { ownedAgentIds: [], principalId: aliceId });
      expect(onlyTriggered.rows.map((x) => [x.key, x.costUsd])).toEqual([[I1, "0.3"]]);
      expect(onlyTriggered.unattributed).toEqual({ runs: 0, costUsd: "0" });
    } finally {
      await db.run.deleteMany({ where: { id: r8 } });
    }
  });

  it("reports unattributed spend separately", async () => {
    const r = await costReport(db, q({}), alice);
    expect(r.unattributed).toEqual({ runs: 1, costUsd: "0.25" });
  });

  it("groups by model and by run", async () => {
    expect((await costReport(db, q({ groupBy: "model" }), alice)).rows.map((x) => [x.key, x.costUsd])).toEqual([
      ["m1", "3"],
      ["m2", "0.5"],
    ]);
    expect((await costReport(db, q({ groupBy: "run", issueKey: I1 }), alice)).rows.map((x) => x.key).sort()).toEqual(
      [r1, r2].sort(),
    );
  });

  it("truncates at the limit", async () => {
    const r = await costReport(db, q({ groupBy: "run", limit: 1 }), alice);
    expect(r.rows).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });
});
