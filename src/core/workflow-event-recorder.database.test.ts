/**
 * The workflow event recorder against real PostgreSQL: work item resolution
 * (given, run attribution, PR issue link), project + agent link matching,
 * per-link event filters, channel de-duplication, the dedupeKey guarantee
 * under concurrency, and provider gating. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "./db.js";
import { createWorkflowEventRecorder } from "./workflow-event-recorder.js";

describe.skipIf(!process.env.DATABASE_URL)("workflow event recorder (database)", () => {
  const db = createPrismaClient();
  const recorder = createWorkflowEventRecorder(db, ["slack"]);
  const PREFIX = "wfrec-";
  const s = randomUUID();
  const id = (name: string) => `${PREFIX}${name}-${s}`;
  const owner = id("owner");
  const agentA = id("agentA");
  const agentB = id("agentB");
  const runA = id("runA");
  const projectKey = `WFR${Math.floor(Math.random() * 1e9)}`;
  const itemKey = `${projectKey}-1`;
  const tag = s.replace(/-/g, "").slice(0, 12).toUpperCase();
  const cProj = `CPROJ${tag}`;
  const cB = `CB${tag}`;
  const cReviews = `CREVIEWS${tag}`;
  const repo = `acme-${s}/x`;
  const noneRepo = `acme-${s}/none`;

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    for (const agentId of [agentA, agentB]) {
      await db.agent.create({
        data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner },
      });
    }
    await db.run.create({ data: { id: runA, agentId: agentA, status: "succeeded" } });
    const item = await db.workItem.create({
      data: { provider: "jira", key: itemKey, scopeKey: projectKey, title: "Card" },
    });
    await db.runAttribution.create({ data: { runId: runA, workItemId: item.id, source: "issue_event" } });
    await db.issuePullRequest.create({
      data: {
        issueProvider: "jira",
        issueKey: itemKey,
        codeProvider: "github",
        repository: repo,
        number: 7,
        url: "https://github.com/acme/x/pull/7",
        agentId: agentA,
        openedByRunId: runA,
      },
    });
    const link = { provider: "slack", authorizedById: owner };
    await db.notificationChannel.createMany({
      data: [
        { ...link, channelId: cProj, issueProvider: "jira", projectKey },
        { ...link, channelId: cProj, agentId: agentA, includeCost: true },
        { ...link, channelId: cB, agentId: agentB },
        { ...link, channelId: cReviews, issueProvider: "jira", projectKey, events: ["review_posted"] },
      ],
    });
  });

  afterAll(async () => {
    await db.workflowEvent.deleteMany({ where: { dedupeKey: { endsWith: `-${s}` } } });
    await db.notificationChannel.deleteMany({ where: { OR: [{ projectKey }, { agentId: { in: [agentA, agentB] } }] } });
    await db.issuePullRequest.deleteMany({ where: { repository: repo } });
    await db.run.deleteMany({ where: { id: runA } });
    await db.workItem.deleteMany({ where: { provider: "jira", key: itemKey } });
    await db.agent.deleteMany({ where: { id: { in: [agentA, agentB] } } });
    await db.principal.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  it("resolves the work item from the run, de-dupes channels, and ORs includeCost", async () => {
    await recorder({
      dedupeKey: `pick-${s}`,
      runId: runA,
      agentId: agentA,
      payload: { kind: "issue_picked_up", agentName: "A", trigger: "created" },
    });
    const event = await db.workflowEvent.findUniqueOrThrow({
      where: { dedupeKey: `pick-${s}` },
      include: { deliveries: true },
    });
    expect(event).toMatchObject({ workItemProvider: "jira", workItemKey: itemKey, kind: "issue_picked_up" });
    expect(event.deliveries.map((d) => [d.channelId, d.threadKey, d.includeCost]).sort()).toEqual([
      [cProj, `issue:jira:${itemKey}`, true],
    ]);
  });

  it("filters by events (L4 only gets review_posted)", async () => {
    await recorder({
      dedupeKey: `rev-${s}`,
      runId: runA,
      agentId: agentA,
      payload: {
        kind: "review_posted",
        agentName: "A",
        verdict: "APPROVE",
        prLabel: "a/b#1",
        prUrl: null,
        ciPending: false,
      },
    });
    const ev = await db.workflowEvent.findUniqueOrThrow({
      where: { dedupeKey: `rev-${s}` },
      include: { deliveries: true },
    });
    expect(ev.deliveries.map((d) => d.channelId).sort()).toEqual([cProj, cReviews].sort());
  });

  it("falls back to the PR's IssuePullRequest, then to a pr thread", async () => {
    await recorder({
      dedupeKey: `pr-${s}`,
      agentId: agentB,
      pullRequest: { codeProvider: "github", repository: repo, number: 7 },
      payload: {
        kind: "pr_closed",
        prLabel: `${repo}#7`,
        prUrl: "https://github.com/acme/x/pull/7",
        merged: true,
        movedTo: null,
      },
    });
    const ev = await db.workflowEvent.findUniqueOrThrow({
      where: { dedupeKey: `pr-${s}` },
      include: { deliveries: true },
    });
    expect(ev.workItemKey).toBe(itemKey);
    // The agentB link (cB) also matches; the thread is still the issue thread.
    expect(ev.deliveries.find((d) => d.channelId === cB)?.threadKey).toBe(`issue:jira:${itemKey}`);
    await recorder({
      dedupeKey: `pr2-${s}`,
      agentId: agentB,
      pullRequest: { codeProvider: "github", repository: noneRepo, number: 1 },
      payload: {
        kind: "pr_opened",
        prLabel: `${noneRepo}#1`,
        prUrl: "https://github.com/acme/none/pull/1",
        movedTo: null,
      },
    });
    const ev2 = await db.workflowEvent.findUniqueOrThrow({
      where: { dedupeKey: `pr2-${s}` },
      include: { deliveries: true },
    });
    expect(ev2.deliveries[0]?.threadKey).toBe(`pr:github:${noneRepo}#1`);
  });

  it("writes nothing when no link matches, and is idempotent per dedupeKey", async () => {
    await recorder({
      dedupeKey: `none-${s}`,
      agentId: id("no-such-agent"),
      payload: { kind: "run_failed", agentName: "x", status: "failed", reason: null },
    });
    expect(await db.workflowEvent.findUnique({ where: { dedupeKey: `none-${s}` } })).toBeNull();
    const again = {
      dedupeKey: `pick-${s}`,
      runId: runA,
      agentId: agentA,
      payload: { kind: "issue_picked_up", agentName: "A", trigger: "created" },
    } as const;
    await Promise.all([recorder(again), recorder(again)]);
    expect(await db.notificationDelivery.count({ where: { event: { dedupeKey: `pick-${s}` } } })).toBe(1);
  });

  it("records a first-time dedupeKey once under concurrency", async () => {
    const race = {
      dedupeKey: `race-${s}`,
      runId: runA,
      agentId: agentA,
      payload: { kind: "issue_picked_up", agentName: "A", trigger: "created" },
    } as const;
    await Promise.all([recorder(race), recorder(race), recorder(race)]);
    expect(await db.workflowEvent.count({ where: { dedupeKey: `race-${s}` } })).toBe(1);
    expect(await db.notificationDelivery.count({ where: { event: { dedupeKey: `race-${s}` } } })).toBe(1);
  });

  it("ignores links for providers that are not enabled", async () => {
    const off = createWorkflowEventRecorder(db, []);
    await off({
      dedupeKey: `off-${s}`,
      runId: runA,
      agentId: agentA,
      payload: { kind: "issue_picked_up", agentName: "A", trigger: "x" },
    });
    expect(await db.workflowEvent.findUnique({ where: { dedupeKey: `off-${s}` } })).toBeNull();
  });
});
