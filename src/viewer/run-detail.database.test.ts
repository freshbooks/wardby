import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { RunDetailSchema } from "./api-schema.js";
import { loadRunDetail } from "./run-detail.js";

const db = createPrismaClient();
const suffix = randomUUID();
const now = new Date("2030-01-01T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const MIN = 60_000;
const id = (name: string) => `detail-${name}-${suffix}`;
const ids = { A: id("agent-a"), C: id("agent-c"), R1: id("r1"), R2: id("r2"), R3: id("r3"), R4: id("r4") };

describe.skipIf(!process.env.DATABASE_URL)("loadRunDetail (PostgreSQL)", () => {
  beforeAll(async () => {
    await db.agent.create({
      data: { id: ids.A, name: ids.A, systemPrompt: "x", model: "agent-model", budgetUsd: 2 },
    });
    await db.agent.create({
      data: { id: ids.C, name: ids.C, systemPrompt: "x", model: "agent-model", budgetUsd: 1, kind: "coding" },
    });
    await db.run.create({
      data: {
        id: ids.R1,
        agentId: ids.A,
        status: "failed",
        startedAt: ago(10 * MIN),
        error: "boom",
        finalText: "final words",
      },
    });
    // Created out of order: childRunIds must follow startedAt.
    await db.run.create({
      data: { id: ids.R3, agentId: ids.A, parentRunId: ids.R1, status: "running", startedAt: ago(2 * MIN) },
    });
    await db.run.create({
      data: {
        id: ids.R2,
        agentId: ids.C,
        trigger: "subagent",
        parentRunId: ids.R1,
        status: "succeeded",
        startedAt: ago(5 * MIN),
        finishedAt: ago(1 * MIN),
        codingRun: {
          create: {
            task: "t",
            repository: "your-org/app",
            baseRef: "main",
            headRef: "wardby/x",
            provider: "codex",
            model: "coding-model",
            timeoutSec: 60,
            protectedPaths: [],
            budgetReservedUsd: 0.5,
            failureCategory: "tests_failed",
            services: [
              {
                name: "postgres",
                version: "16",
                image: "postgres@sha256:abc",
                port: 5432,
                testEnv: { PGHOST: "localhost", DATABASE_URL: "postgres://x" },
                serviceEnv: { POSTGRES_PASSWORD: "pw" },
              },
            ],
          },
        },
      },
    });
    await db.run.create({
      data: { id: ids.R4, agentId: ids.C, status: "succeeded", startedAt: ago(1 * MIN) },
    });
  });

  afterAll(async () => {
    for (const r of [ids.R4, ids.R3, ids.R2, ids.R1]) await db.run.deleteMany({ where: { id: r } });
    await db.agent.deleteMany({ where: { id: { in: [ids.A, ids.C] } } });
    await db.$disconnect();
  });

  it("returns a coding run's detail with env names only", async () => {
    const detail = await loadRunDetail(db, ids.R2);
    expect(detail).not.toBeNull();
    expect(RunDetailSchema.parse(detail)).toEqual(detail);
    expect(detail!.model).toBe("coding-model");
    expect(detail!.codingProvider).toBe("codex");
    expect(detail!.coding).toMatchObject({
      provider: "codex",
      repository: "your-org/app",
      baseRef: "main",
      headRef: "wardby/x",
      queuedAt: null,
      failureCategory: "tests_failed",
    });
    expect(detail!.coding!.services).toEqual([
      { name: "postgres", version: "16", image: "postgres@sha256:abc", envNames: ["DATABASE_URL", "PGHOST"] },
    ]);
    const json = JSON.stringify(detail);
    expect(json).not.toContain("postgres://x");
    expect(json).not.toContain('"pw"');
    expect(json).not.toContain("POSTGRES_PASSWORD");
  });

  it("returns a native run's detail with ordered child ids and null coding", async () => {
    const detail = await loadRunDetail(db, ids.R1);
    expect(RunDetailSchema.parse(detail)).toEqual(detail);
    expect(detail).toMatchObject({
      model: "agent-model",
      codingProvider: null,
      error: "boom",
      finalText: "final words",
      coding: null,
    });
    expect(detail!.childRunIds).toEqual([ids.R2, ids.R3]);
  });

  it("returns a coding-agent run without a CodingRun row as native detail", async () => {
    const detail = await loadRunDetail(db, ids.R4);
    expect(detail!.coding).toBeNull();
    expect(detail!.model).toBe("agent-model");
    expect(detail!.codingProvider).toBeNull();
  });

  it("returns null for an unknown run", async () => {
    expect(await loadRunDetail(db, id("missing"))).toBeNull();
  });
});
