/**
 * Cost attribution against real PostgreSQL: dispatchRun writes the WorkItem
 * and RunAttribution in its Serializable persist transaction, children inherit,
 * and the item's parent is frozen per run. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Executor } from "../providers/executor/types.js";
import type { AttributionIntent } from "./attribution.js";
import { createPrismaClient } from "./db.js";
import { dispatchRun } from "./dispatch.js";

describe.skipIf(!process.env.DATABASE_URL)("attribution (database)", () => {
  const db = createPrismaClient();
  const PREFIX = "attrdb-";
  const suffix = randomUUID();
  const owner = `${PREFIX}owner-${suffix}`;
  const id = (name: string) => `${PREFIX}${name}-${suffix}`;
  // An ISSUE_KEY-shaped key unique to this test run: uppercase letters, a dash, a number.
  const project = `ATTR${suffix
    .slice(0, 6)
    .toUpperCase()
    .replace(/[^A-Z]/g, "X")}`;
  const issueKey = (n: number) => `${project}-${n}`;
  const executor: Executor = { async start() {}, async stop() {} };
  /** In dispatch order, so parents come before their children. */
  const runIds: string[] = [];

  async function nativeAgent(name: string): Promise<string> {
    const agentId = id(name);
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner },
    });
    return agentId;
  }

  async function codingAgent(name: string): Promise<string> {
    const agentId = id(name);
    await db.agent.create({
      data: {
        id: agentId,
        name: agentId,
        systemPrompt: "Fix things.",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        kind: "coding",
        ownerId: owner,
        codingProfile: {
          create: { provider: "codex", repository: "openai/example", defaultTask: "Fix it.", protectedPaths: [] },
        },
      },
    });
    return agentId;
  }

  async function dispatch(agentId: string, extra: Partial<Parameters<typeof dispatchRun>[0]> = {}): Promise<string> {
    const r = await dispatchRun({ db, executor, agentId, trigger: "manual", ...extra });
    runIds.push(r!.run.id);
    return r!.run.id;
  }

  const intent = (key: string, parent?: string): AttributionIntent => ({
    source: "issue_event",
    item: {
      provider: "jira",
      key,
      scopeKey: project,
      snapshot: {
        key,
        title: `title ${key}`,
        type: "Story",
        url: `https://example.test/browse/${key}`,
        scopeKey: project,
        ...(parent ? { parent: { key: parent, title: `epic ${parent}`, kind: "epic" } } : {}),
      },
    },
  });

  async function cleanup(): Promise<void> {
    // Children before parents (Run.parentRunId has no cascade); RunAttribution cascades with its run.
    await db.codingRun.deleteMany({ where: { runId: { in: runIds } } });
    for (const runId of [...runIds].reverse()) await db.run.deleteMany({ where: { id: runId } });
    await db.run.deleteMany({ where: { agentId: { startsWith: PREFIX } } });
    await db.workItem.deleteMany({ where: { provider: "jira", key: { startsWith: `${project}-` } } });
    await db.codingAgentProfile.deleteMany({ where: { agentId: { startsWith: PREFIX } } });
    await db.agent.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await db.principal.deleteMany({ where: { id: owner } });
  }

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
  });

  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it("writes the item, its parent, and a frozen parentKeyAtRun", async () => {
    const agentId = await nativeAgent("a1");
    const key = issueKey(1);
    const epic = issueKey(100);
    const runId = await dispatch(agentId, { attribution: intent(key, epic) });
    const row = await db.runAttribution.findUniqueOrThrow({ where: { runId }, include: { workItem: true } });
    expect(row).toMatchObject({ source: "issue_event", parentKeyAtRun: epic });
    expect(row.workItem).toMatchObject({ key, title: `title ${key}`, parentKey: epic, parentKind: "epic" });
    expect(row.workItem.refreshedAt).not.toBeNull();
    expect(await db.workItem.findUnique({ where: { provider_key: { provider: "jira", key: epic } } })).toMatchObject({
      title: `epic ${epic}`,
      scopeKey: project,
      refreshedAt: null,
    });
  });

  it("children, grandchildren and great-grandchildren inherit, and cannot override", async () => {
    const agentId = await nativeAgent("a2");
    const root = await dispatch(agentId, { attribution: intent(issueKey(2)) });
    const child = await dispatch(agentId, { parentRunId: root, attribution: intent(issueKey(3)) });
    const grandchild = await dispatch(agentId, { parentRunId: child });
    const great = await dispatch(agentId, { parentRunId: grandchild });
    for (const runId of [child, grandchild, great]) {
      const row = await db.runAttribution.findUniqueOrThrow({ where: { runId }, include: { workItem: true } });
      expect(row.source).toBe("inherited");
      expect(row.workItem.key).toBe(issueKey(2));
    }
    expect(
      await db.workItem.findUnique({ where: { provider_key: { provider: "jira", key: issueKey(3) } } }),
    ).toBeNull();
  });

  it("an issue moved between epics keeps old runs under the old epic", async () => {
    const agentId = await nativeAgent("a3");
    const key = issueKey(4);
    const first = await dispatch(agentId, { attribution: intent(key, issueKey(101)) });
    const second = await dispatch(agentId, { attribution: intent(key, issueKey(102)) });
    expect((await db.runAttribution.findUniqueOrThrow({ where: { runId: first } })).parentKeyAtRun).toBe(issueKey(101));
    expect((await db.runAttribution.findUniqueOrThrow({ where: { runId: second } })).parentKeyAtRun).toBe(
      issueKey(102),
    );
    expect(
      (await db.workItem.findUniqueOrThrow({ where: { provider_key: { provider: "jira", key } } })).parentKey,
    ).toBe(issueKey(102));
  });

  it("a key-only intent never clobbers a populated WorkItem", async () => {
    const agentId = await nativeAgent("a4");
    const key = issueKey(5);
    await dispatch(agentId, { attribution: intent(key, issueKey(103)) });
    const keyOnly = await dispatch(agentId, {
      attribution: { source: "explicit", item: { provider: "jira", key, scopeKey: project, snapshot: null } },
    });
    expect(await db.workItem.findUniqueOrThrow({ where: { provider_key: { provider: "jira", key } } })).toMatchObject({
      title: `title ${key}`,
      parentKey: issueKey(103),
    });
    expect(await db.runAttribution.findUniqueOrThrow({ where: { runId: keyOnly } })).toMatchObject({
      source: "explicit",
      parentKeyAtRun: issueKey(103),
    });
  });

  it("a key-only intent for a new key creates a bare WorkItem", async () => {
    const agentId = await nativeAgent("a7");
    const key = issueKey(7);
    await dispatch(agentId, {
      attribution: { source: "explicit", item: { provider: "jira", key, scopeKey: project, snapshot: null } },
    });
    expect(await db.workItem.findUniqueOrThrow({ where: { provider_key: { provider: "jira", key } } })).toMatchObject({
      scopeKey: project,
      title: null,
      parentKey: null,
      refreshedAt: null,
    });
  });

  it("concurrent first dispatches on one key make one WorkItem", async () => {
    const agentId = await nativeAgent("a5");
    const key = issueKey(6);
    const ids = await Promise.all([1, 2, 3, 4].map(() => dispatch(agentId, { attribution: intent(key) })));
    expect(await db.workItem.count({ where: { provider: "jira", key } })).toBe(1);
    expect(await db.runAttribution.count({ where: { runId: { in: ids } } })).toBe(4);
  });

  it("a continuation inherits the continued coding run's attribution, and its CodingRun the issue", async () => {
    const agentId = await codingAgent("c1");
    const key = issueKey(8);
    const root = await dispatch(agentId, { attribution: intent(key) });
    const rootCoding = await db.codingRun.findUniqueOrThrow({ where: { runId: root } });
    expect(rootCoding).toMatchObject({ issueProvider: "jira", issueKey: key });
    await db.codingRun.update({
      where: { runId: root },
      data: {
        result: {
          schemaVersion: 1,
          outcome: "pull_request_opened",
          repository: rootCoding.repository,
          baseRef: rootCoding.baseRef,
          headRef: rootCoding.headRef,
          commitSha: "a".repeat(40),
          pullRequestUrl: "https://github.com/openai/example/pull/1",
          pullRequestNumber: 1,
          summary: "Opened the PR",
          tests: [],
          usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        },
      },
    });
    const next = await dispatch(agentId, { continuesCodingRunId: root, attribution: intent(issueKey(9)) });
    expect(
      await db.runAttribution.findUniqueOrThrow({ where: { runId: next }, include: { workItem: true } }),
    ).toMatchObject({ source: "inherited", workItem: { key } });
    expect(await db.codingRun.findUniqueOrThrow({ where: { runId: next } })).toMatchObject({
      issueProvider: "jira",
      issueKey: key,
    });
  });

  it("a run with no intent and no attributed ancestor is unattributed", async () => {
    const agentId = await nativeAgent("a6");
    const runId = await dispatch(agentId);
    expect(await db.runAttribution.findUnique({ where: { runId } })).toBeNull();
  });
});
