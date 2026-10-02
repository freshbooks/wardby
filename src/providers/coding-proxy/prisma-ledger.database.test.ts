import { randomUUID } from "node:crypto";
import { createPrismaClient } from "../../core/db.js";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaProxyLedger } from "./prisma-ledger.js";

const db = createPrismaClient();
const suffix = randomUUID();
const agentId = `proxy-agent-${suffix}`;
const runId = `proxy-run-${suffix}`;
const sessionId = `proxy-session-${suffix}`;

describe.skipIf(!process.env.DATABASE_URL)("PrismaProxyLedger (PostgreSQL)", () => {
  afterAll(async () => {
    await db.$executeRaw`DELETE FROM "CodingProxySession" WHERE "id" = ${sessionId}`;
    await db.codingRun.deleteMany({ where: { runId } });
    await db.run.deleteMany({ where: { id: runId } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.$disconnect();
  });

  it("serializes admission and keeps completion idempotent across adapter restarts", async () => {
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "x", model: "gpt-5.6-luna", budgetUsd: 1 },
    });
    await db.run.create({ data: { id: runId, agentId, executionManaged: true } });
    await db.codingRun.create({
      data: {
        runId,
        task: "test",
        repository: "openai/example",
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        provider: "codex",
        model: "gpt-5.6-luna",
        timeoutSec: 60,
        allowedEgress: [],
        protectedPaths: [],
        budgetReservedUsd: 0.0002,
      },
    });
    const ledger = new PrismaProxyLedger(db);
    await ledger.createSession({
      id: sessionId,
      runId,
      capabilityHash: `hash-${suffix}`,
      credentialRef: "openai/test",
      protocol: "openai-responses",
      allowedModels: ["gpt-5.6-luna"],
      deadlineAt: new Date(Date.now() + 60_000),
      budgetUsd: 0.0002,
      registryTokenHash: `registry-hash-${suffix}`,
    });
    expect(await ledger.findSessionByCapabilityHash(`hash-${suffix}`)).toMatchObject({
      protocol: "openai-responses",
      budgetExhaustedAt: null,
      upstreamFailure: null,
    });
    expect(await ledger.budgetExhausted(sessionId)).toBe(false);
    expect(await ledger.upstreamFailure(sessionId)).toBeNull();
    await ledger.recordUpstreamFailure(sessionId, "project_spend_limit_exceeded");
    await new PrismaProxyLedger(db).recordUpstreamFailure(sessionId, "server_error");
    expect(await ledger.upstreamFailure(sessionId)).toBe("project_spend_limit_exceeded");
    expect((await ledger.findSessionByCapabilityHash(`hash-${suffix}`))?.upstreamFailure).toBe(
      "project_spend_limit_exceeded",
    );
    expect(await ledger.upstreamFailure(`missing-${suffix}`)).toBeNull();
    const request = (id: string) => ({
      id: `${id}-${suffix}`,
      sessionId,
      requestKey: id,
      requestFingerprint: `fingerprint-${id}`,
      model: "gpt-5.6-luna",
      reservationUsd: 0.0001,
      pricing: { version: "test", encoding: "o200k_base" as const, inputPerMTok: 1, outputPerMTok: 1 },
      now: new Date(),
    });
    const [first, second] = await Promise.all([ledger.reserve(request("a")), ledger.reserve(request("b"))]);
    const admitted = [first, second].filter((result) => result.outcome === "reserved");
    expect(admitted).toHaveLength(1);
    expect([first.outcome, second.outcome]).toContain("budget_exhausted");
    const refusedAt = (await ledger.findSessionByCapabilityHash(`hash-${suffix}`))?.budgetExhaustedAt;
    expect(refusedAt).toBeInstanceOf(Date);
    expect(await ledger.budgetExhausted(sessionId)).toBe(true);
    expect(await ledger.budgetExhausted(`missing-${suffix}`)).toBe(false);
    const later = await ledger.reserve({ ...request("c"), now: new Date(Date.now() + 5_000) });
    expect(later.outcome).toBe("budget_exhausted");
    expect((await ledger.findSessionByCapabilityHash(`hash-${suffix}`))?.budgetExhaustedAt).toEqual(refusedAt);

    const requestId = admitted[0].outcome === "reserved" ? admitted[0].request.id : "";
    const usage = { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, cacheWriteTokens: 0, reasoningTokens: 1 };
    await ledger.complete(requestId, usage, 0.00005, 200);
    await new PrismaProxyLedger(db).complete(requestId, usage, 0.00005, 200);

    const persisted = await new PrismaProxyLedger(db).getRequest(requestId);
    const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
    expect(persisted).toMatchObject({ status: "completed", actualCostUsd: 0.00005, usage });
    expect(run.tokensIn).toBe(10);
    expect(run.tokensOut).toBe(4);
    expect(Number(run.costUsd)).toBe(0.00005);
    // One completed proxied call (completed twice, idempotently) is one turn.
    expect(run.turns).toBe(1);
  });

  describe("per-model usage (RunModelUsage)", () => {
    const uAgent = `usage-agent-${suffix}`;
    const uRun = `usage-run-${suffix}`;
    const uSession = `usage-session-${suffix}`;
    const modelA = "model-a";
    const modelB = "model-b";
    const ledger = new PrismaProxyLedger(db);
    const u = (inputTokens: number, cachedInputTokens: number, cacheWriteTokens: number, outputTokens: number) => ({
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteTokens,
      reasoningTokens: 0,
    });
    const reserveOn = async (key: string, model: string) => {
      const result = await ledger.reserve({
        id: `${key}-${suffix}`,
        sessionId: uSession,
        requestKey: key,
        requestFingerprint: `fingerprint-${key}`,
        model,
        reservationUsd: 0.001,
        pricing: { version: "test", encoding: "o200k_base" as const, inputPerMTok: 1, outputPerMTok: 1 },
        now: new Date(),
      });
      if (result.outcome !== "reserved") throw new Error(`unexpected ${result.outcome}`);
      return result.request.id;
    };

    afterAll(async () => {
      await db.$executeRaw`DELETE FROM "CodingProxySession" WHERE "id" = ${uSession}`;
      await db.runModelUsage.deleteMany({ where: { runId: uRun } });
      await db.codingRun.deleteMany({ where: { runId: uRun } });
      await db.run.deleteMany({ where: { id: uRun } });
      await db.agent.deleteMany({ where: { id: uAgent } });
    });

    it("recomputes per-model usage on each completion, by priced token kind", async () => {
      await db.agent.create({
        data: { id: uAgent, name: uAgent, systemPrompt: "x", model: modelA, budgetUsd: 1 },
      });
      await db.run.create({ data: { id: uRun, agentId: uAgent, executionManaged: true } });
      await db.codingRun.create({
        data: {
          runId: uRun,
          task: "test",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${uRun}`,
          provider: "codex",
          model: modelA,
          timeoutSec: 60,
          allowedEgress: [],
          protectedPaths: [],
          budgetReservedUsd: 1,
        },
      });
      await ledger.createSession({
        id: uSession,
        runId: uRun,
        capabilityHash: `usage-hash-${suffix}`,
        credentialRef: "openai/test",
        protocol: "openai-responses",
        allowedModels: [modelA, modelB],
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 1,
        registryTokenHash: `usage-registry-hash-${suffix}`,
      });
      await ledger.complete(await reserveOn("a1", modelA), u(1000, 800, 100, 50), 0.01, 200);
      await ledger.complete(await reserveOn("a2", modelA), u(500, 400, 0, 20), 0.005, 200);
      await ledger.complete(await reserveOn("b1", modelB), u(200, 0, 0, 10), 0.002, 200);

      const rows = await db.runModelUsage.findMany({ where: { runId: uRun }, orderBy: { model: "asc" } });
      expect(rows.map((r) => ({ ...r, costUsd: Number(r.costUsd) }))).toEqual([
        {
          runId: uRun,
          model: modelA,
          freshInputTokens: 300,
          cachedInputTokens: 1200,
          cacheWriteTokens: 100,
          outputTokens: 70,
          costUsd: expect.closeTo(0.015, 10),
        },
        {
          runId: uRun,
          model: modelB,
          freshInputTokens: 200,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 10,
          costUsd: expect.closeTo(0.002, 10),
        },
      ]);
      const run = await db.run.findUniqueOrThrow({ where: { id: uRun } });
      const sum = rows.reduce((total, r) => total + Number(r.costUsd), 0);
      expect(Number(run.costUsd)).toBeCloseTo(sum, 6);
    });

    it("a repeated completion does not double the per-model row", async () => {
      const before = await db.runModelUsage.findUniqueOrThrow({
        where: { runId_model: { runId: uRun, model: modelA } },
      });
      await new PrismaProxyLedger(db).complete(`a1-${suffix}`, u(1000, 800, 100, 50), 0.01, 200);
      const after = await db.runModelUsage.findUniqueOrThrow({
        where: { runId_model: { runId: uRun, model: modelA } },
      });
      expect(after).toEqual(before);
      expect(after.outputTokens).toBe(70);
    });

    it("never fails a completion when the per-model write fails", async () => {
      // A trigger that rejects only this test's model makes the RunModelUsage write fail (like a missing grant).
      const failModel = `fail-model-${suffix}`;
      const fn = `fail_rmu_${suffix.replaceAll("-", "_")}`;
      await db.$executeRawUnsafe(
        `CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."model" = '${failModel}' THEN RAISE EXCEPTION 'denied'; END IF; RETURN NEW; END $$`,
      );
      await db.$executeRawUnsafe(
        `CREATE TRIGGER "${fn}" BEFORE INSERT OR UPDATE ON "RunModelUsage" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`,
      );
      try {
        const before = await db.run.findUniqueOrThrow({ where: { id: uRun } });
        const id = await reserveOn("f1", failModel);
        const done = await ledger.complete(id, u(100, 0, 0, 5), 0.001, 200);
        expect(done.status).toBe("completed");
        const run = await db.run.findUniqueOrThrow({ where: { id: uRun } });
        expect(run.tokensIn).toBe(before.tokensIn + 100);
        expect(Number(run.costUsd)).toBeCloseTo(Number(before.costUsd) + 0.001, 6);
        expect(await db.runModelUsage.count({ where: { runId: uRun, model: failModel } })).toBe(0);
        // Rolling back to the savepoint leaves the rows already recorded for the other models intact.
        const rows = await db.runModelUsage.count({ where: { runId: uRun } });
        expect(rows).toBe(2);
      } finally {
        await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${fn}" ON "RunModelUsage"`);
        await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${fn}"()`);
      }
    });
  });
});
