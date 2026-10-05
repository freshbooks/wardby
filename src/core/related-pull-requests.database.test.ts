/** The group query against real PostgreSQL: up to the top-level run, down every depth, continuations both ways. Skipped without DATABASE_URL. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "./db.js";
import { collectRelatedPullRequests, openSiblings } from "./related-pull-requests.js";

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
  async function coding(runId: string, result: unknown, rootCodingRunId?: string, issue = true) {
    await db.codingRun.create({
      data: {
        runId,
        task: "t",
        repository: (result as { repository: string }).repository ?? "acme/app",
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        provider: "codex",
        model: "m",
        timeoutSec: 900,
        protectedPaths: [],
        budgetReservedUsd: 1,
        result: result as object,
        ...(issue ? { issueProvider: "jira", issueKey: "RELPR-1" } : {}),
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

    // No tracked issue: lead2 opens A#1, B#2; follow-up F continues A#1 and opens C#3; G continues B#2 only.
    await run(id("lead2"), 40);
    await run(id("a"), 41, id("lead2"));
    await coding(id("a"), opened("acme/a", 1), undefined, false);
    await run(id("b"), 42, id("lead2"));
    await coding(id("b"), opened("acme/b", 2), undefined, false);
    await run(id("F"), 50);
    await run(id("f1"), 51, id("F"));
    await coding(id("f1"), { ...opened("acme/a", 1), outcome: "pull_request_updated" }, id("a"), false);
    await run(id("f2"), 52, id("F"));
    await coding(id("f2"), opened("acme/c", 3), undefined, false);
    await run(id("G"), 60);
    await run(id("g1"), 61, id("G"));
    await coding(id("g1"), { ...opened("acme/b", 2), outcome: "pull_request_updated" }, id("b"), false);
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

  it("reaches a later follow-up's new pull request from a sibling it never touched", async () => {
    const group = await collectRelatedPullRequests(db, id("G"));
    expect(group.pullRequests.map((p) => `${p.repository}#${p.number}`)).toEqual(["acme/a#1", "acme/b#2", "acme/c#3"]);
    expect(group.issue).toBeUndefined();
    expect(await openSiblings(db, id("b"), { repository: "acme/b", number: 2 })).toEqual([
      { repository: "acme/a", number: 1, openedByRunId: id("a") },
      { repository: "acme/c", number: 3, openedByRunId: id("f2") },
    ]);
  });
});
