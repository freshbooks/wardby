import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { reportServiceState } from "../providers/jobs/service-state.js";
import { prismaServiceStateReporter } from "./coding-service-status.js";
import { createPrismaClient } from "./db.js";

const db = createPrismaClient();
const suffix = randomUUID();
const agentId = `svc-status-agent-${suffix}`;
const runId = `svc-status-run-${suffix}`;

describe.skipIf(!process.env.DATABASE_URL)("prismaServiceStateReporter (PostgreSQL)", () => {
  afterAll(async () => {
    await db.run.deleteMany({ where: { id: runId } }); // cascades to CodingRunServiceStatus
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.$disconnect();
  });

  it("upserts one row per run x service and stamps readyAt / failedAt on those transitions", async () => {
    await db.agent.create({ data: { id: agentId, name: agentId, systemPrompt: "x", model: "m", budgetUsd: 1 } });
    await db.run.create({ data: { id: runId, agentId } });
    const readyAt = new Date("2026-10-02T12:00:05.000Z");
    const failedAt = new Date("2026-10-02T12:00:09.000Z");
    let clock = new Date("2026-10-02T12:00:00.000Z");
    const report = prismaServiceStateReporter(db, () => clock);

    await report({ runId, name: "postgres", state: "pending" });
    await report({ runId, name: "redis", state: "pending" });
    await report({ runId, name: "postgres", state: "probing", attempts: 2 });
    clock = readyAt;
    await report({ runId, name: "postgres", state: "ready", attempts: 3 });
    clock = failedAt;
    await report({ runId, name: "redis", state: "failed", reason: "exited" });

    const rows = await db.codingRunServiceStatus.findMany({ where: { runId }, orderBy: { name: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: "postgres",
      state: "ready",
      attempts: 3,
      reason: null,
      readyAt,
      failedAt: null,
    });
    expect(rows[1]).toMatchObject({ name: "redis", state: "failed", attempts: null, reason: "exited", failedAt });
  });

  it("reportServiceState swallows reporter errors and ignores a missing reporter", async () => {
    await expect(reportServiceState(undefined, { runId, name: "x", state: "pending" })).resolves.toBeUndefined();
    const failing = async () => {
      throw new Error("db down");
    };
    await expect(reportServiceState(failing, { runId, name: "x", state: "pending" })).resolves.toBeUndefined();
  });
});
