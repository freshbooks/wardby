/** The group query against real PostgreSQL: up to the top-level run, down every depth, continuation second pass. Skipped without DATABASE_URL. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "./db.js";
import { collectRelatedPullRequests } from "./related-pull-requests.js";

describe.skipIf(!process.env.DATABASE_URL)("collectRelatedPullRequests (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID();
  const id = (name: string) => `relpr-${name}-${suffix}`;
  const owner = id("owner");
  const agentId = id("agent");
  const t = (minute: number) => new Date(Date.UTC(2026, 9, 5, 12, minute));

  async function run(runId: string, minute: number, parentRunId?: string) {
    await db.run.create({
      data: { id: runId, agentId, status: "succeeded", startedAt: t(minute), ...(parentRunId ? { parentRunId } : {}) },
    });
  }
  async function coding(runId: string, result: unknown, rootCodingRunId?: string) {
    await db.codingRun.create({
      data: {
        runId,
        task: "t",
        repository: "acme/app",
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        provider: "codex",
        model: "m",
        timeoutSec: 900,
        protectedPaths: [],
        budgetReservedUsd: 1,
        result: result as object,
        issueProvider: "jira",
        issueKey: "RELPR-1",
        ...(rootCodingRunId ? { rootCodingRunId } : {}),
      },
    });
  }
  const opened = (repository: string, n: number) => ({
    outcome: "pull_request_opened",
    repository,
    pullRequestNumber: n,
    pullRequestUrl: `https://github.com/${repository}/pull/${n}`,
  });

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 10, ownerId: owner },
    });
    await run(id("lead"), 0);
    await run(id("mid"), 1, id("lead")); // a nested native parent
    await run(id("c1"), 2, id("mid"));
    await coding(id("c1"), opened("acme/order-service", 2));
    await run(id("c2"), 3, id("lead"));
    await coding(id("c2"), opened("acme/app", 4));
    await run(id("follow"), 30); // a later, separate request continuing acme/app#4
    await run(id("c9"), 31, id("follow"));
    await coding(id("c9"), { ...opened("acme/app", 4), outcome: "pull_request_updated" }, id("c2"));
  });

  afterAll(async () => {
    await db.codingRun.deleteMany({ where: { runId: { startsWith: "relpr-", endsWith: suffix } } });
    await db.run.deleteMany({ where: { agentId } });
    await db.agent.delete({ where: { id: agentId } });
    await db.principal.delete({ where: { id: owner } });
    await db.$disconnect();
  });

  it("finds every depth from any run in the tree, in dispatch order", async () => {
    for (const seed of [id("lead"), id("mid"), id("c2")]) {
      const group = await collectRelatedPullRequests(db, seed);
      expect(group.pullRequests.map((p) => `${p.repository}#${p.number}`)).toEqual([
        "acme/order-service#2",
        "acme/app#4",
      ]);
    }
  });

  it("resolves a follow-up request to the original request's set", async () => {
    const group = await collectRelatedPullRequests(db, id("follow"));
    expect(group.pullRequests.map((p) => `${p.repository}#${p.number}`)).toEqual([
      "acme/order-service#2",
      "acme/app#4",
    ]);
    expect(group.issue).toEqual({ provider: "jira", key: "RELPR-1" });
  });
});
