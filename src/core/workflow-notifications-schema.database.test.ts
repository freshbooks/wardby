/**
 * Workflow notification tables against real PostgreSQL: the one-subject
 * CHECK, dedupeKey uniqueness, and per-channel delivery uniqueness.
 * Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "./db.js";

describe.skipIf(!process.env.DATABASE_URL)("workflow notification schema (database)", () => {
  const db = createPrismaClient();
  const s = randomUUID();
  const owner = `wfn-owner-${s}`;
  const agentId = `wfn-agent-${s}`;
  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner },
    });
  });
  afterAll(async () => {
    await db.workflowEvent.deleteMany({ where: { dedupeKey: { endsWith: s } } });
    await db.notificationChannel.deleteMany({ where: { channelId: { endsWith: s.toUpperCase() } } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  it("rejects a link with both a project and an agent subject", async () => {
    await expect(
      db.notificationChannel.create({
        data: {
          provider: "slack",
          channelId: `C1${s.toUpperCase()}`,
          issueProvider: "jira",
          projectKey: "PAY",
          agentId,
          authorizedById: "admin",
        },
      }),
    ).rejects.toThrow(/NotificationChannel_one_subject/);
  });

  it("rejects a link with no subject", async () => {
    await expect(
      db.notificationChannel.create({
        data: { provider: "slack", channelId: `C2${s.toUpperCase()}`, authorizedById: "admin" },
      }),
    ).rejects.toThrow(/NotificationChannel_one_subject/);
  });

  it("dedupes events by dedupeKey and deliveries by (event, channel)", async () => {
    const e = await db.workflowEvent.create({ data: { kind: "pr_opened", dedupeKey: `k-${s}`, payload: {} } });
    await expect(
      db.workflowEvent.create({ data: { kind: "pr_opened", dedupeKey: `k-${s}`, payload: {} } }),
    ).rejects.toThrow();
    await db.notificationDelivery.create({
      data: { eventId: e.id, provider: "slack", channelId: "C9", threadKey: "t" },
    });
    await expect(
      db.notificationDelivery.create({ data: { eventId: e.id, provider: "slack", channelId: "C9", threadKey: "t" } }),
    ).rejects.toThrow();
  });
});
