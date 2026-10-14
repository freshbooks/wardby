import { randomUUID } from "node:crypto";
import { createPrismaClient } from "../../core/db.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaContainerExecutionStore } from "./container.js";

const db = createPrismaClient();
const suffix = randomUUID();
const principalId = `container-principal-${suffix}`;
const agentId = `container-agent-${suffix}`;

// Tests that create active (slot-holding) or queued coding runs live in
// src/core/coding-concurrency.database.test.ts instead: they depend on
// global slot/queue state and race each other across parallel test files.
describe.skipIf(!process.env.DATABASE_URL)("PrismaContainerExecutionStore (PostgreSQL)", () => {
  beforeAll(async () => {
    await db.principal.create({ data: { id: principalId, subject: principalId } });
    await db.agent.create({
      data: {
        id: agentId,
        name: agentId,
        systemPrompt: "code safely",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        kind: "coding",
        ownerId: principalId,
      },
    });
  });

  afterAll(async () => {
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: principalId } });
    await db.$disconnect();
  });

  it("loads the agent's current profile repository and its authorization stamp with the run", async () => {
    const runId = `container-auth-${randomUUID()}`;
    try {
      await db.codingAgentProfile.upsert({
        where: { agentId },
        create: {
          agentId,
          repository: "openai/example",
          protectedPaths: ["CODEOWNERS"],
          repositoryAuthorizedVia: "host_permission",
          repositoryAuthorizedById: principalId,
        },
        update: {},
      });
      await db.run.create({ data: { id: runId, agentId, executionManaged: true } });
      await db.codingRun.create({
        data: {
          runId,
          task: "Fix it.",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${runId}`,
          provider: "codex",
          model: "gpt-5.6-luna",
          timeoutSec: 900,
          allowedEgress: [],
          protectedPaths: ["CODEOWNERS"],
          budgetReservedUsd: 1,
        },
      });
      await expect(new PrismaContainerExecutionStore(db).load(runId)).resolves.toMatchObject({
        ownerId: principalId,
        repository: "openai/example",
        profileRepository: "openai/example",
        repositoryAuthorizedVia: "host_permission",
      });
    } finally {
      await db.codingRun.deleteMany({ where: { runId } });
      await db.run.deleteMany({ where: { id: runId } });
      await db.codingAgentProfile.deleteMany({ where: { agentId } });
    }
  });

  it("persists a sanitized failure category and opaque diagnostic ID separately from the terminal state", async () => {
    const failedRunId = `container-failed-${randomUUID()}`;
    try {
      await db.run.create({ data: { id: failedRunId, agentId, executionManaged: true } });
      await db.codingRun.create({
        data: {
          runId: failedRunId,
          task: "Never persist this task in failure metadata.",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${failedRunId}`,
          provider: "codex",
          model: "gpt-5.6-luna",
          timeoutSec: 900,
          allowedEgress: [],
          protectedPaths: ["CODEOWNERS"],
          budgetReservedUsd: 1,
        },
      });

      const store = new PrismaContainerExecutionStore(db);
      await store.terminate(failedRunId, "failed", "coding_failure_artifact:coding_diag_opaque", {
        failureCategory: "artifact",
        diagnosticId: "coding_diag_opaque",
      });

      await expect(db.codingRun.findUniqueOrThrow({ where: { runId: failedRunId } })).resolves.toMatchObject({
        failureCategory: "artifact",
        diagnosticId: "coding_diag_opaque",
      });
    } finally {
      await db.codingRun.deleteMany({ where: { runId: failedRunId } });
      await db.run.deleteMany({ where: { id: failedRunId } });
    }
  });

  it("refuses to claim a run that is no longer pending/running, and leaves no claim behind", async () => {
    const alreadyFailedRunId = `container-already-failed-${randomUUID()}`;
    try {
      await db.run.create({
        data: {
          id: alreadyFailedRunId,
          agentId,
          executionManaged: true,
          status: "failed",
          error: "some_other_failure",
        },
      });
      await db.codingRun.create({
        data: {
          runId: alreadyFailedRunId,
          task: "Fix it.",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${alreadyFailedRunId}`,
          provider: "codex",
          model: "gpt-5.6-luna",
          timeoutSec: 900,
          allowedEgress: [],
          protectedPaths: ["CODEOWNERS"],
          budgetReservedUsd: 1,
        },
      });

      const store = new PrismaContainerExecutionStore(db);
      await expect(store.claimProvisioning(alreadyFailedRunId, "claim-late")).resolves.toBe("unavailable");

      const coding = await db.codingRun.findUniqueOrThrow({ where: { runId: alreadyFailedRunId } });
      expect(coding.jobBackend).toBeNull();
      expect(coding.jobHandle).toBeNull();
      const run = await db.run.findUniqueOrThrow({ where: { id: alreadyFailedRunId } });
      expect(run.status).toBe("failed");
      expect(run.error).toBe("some_other_failure");
    } finally {
      await db.codingRun.deleteMany({ where: { runId: alreadyFailedRunId } });
      await db.run.deleteMany({ where: { id: alreadyFailedRunId } });
    }
  });
  /** A succeeded coding run with a stored result summary; extra CodingRun columns from `data`. */
  async function codingRunWith(runId: string, summary: string, data: Record<string, unknown> = {}) {
    await db.run.create({ data: { id: runId, agentId, executionManaged: true, status: "succeeded" } });
    await db.codingRun.create({
      data: {
        runId,
        task: "Fix it.",
        repository: "openai/example",
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        provider: "codex",
        model: "gpt-5.6-luna",
        timeoutSec: 900,
        allowedEgress: [],
        protectedPaths: ["CODEOWNERS"],
        budgetReservedUsd: 1,
        result: { outcome: "pull_request_opened", summary },
        ...data,
      },
    });
  }

  it("recordPullRequestDescription only updates when the expected hash matches (null for legacy)", async () => {
    const legacy = `container-desc-legacy-${randomUUID()}`;
    const recorded = `container-desc-recorded-${randomUUID()}`;
    const [h1, h2, h3] = ["1", "2", "3"].map((c) => c.repeat(64));
    try {
      await codingRunWith(legacy, "Legacy text.");
      await codingRunWith(recorded, "Root text.", { prDescriptionSha256: h1, prDescriptionRunId: recorded });
      const store = new PrismaContainerExecutionStore(db);
      const row = (runId: string) =>
        db.codingRun.findUniqueOrThrow({
          where: { runId },
          select: { prDescriptionSha256: true, prDescriptionRunId: true },
        });

      // A legacy row (no hash) only matches an expected null.
      await expect(
        store.recordPullRequestDescription({ rootRunId: legacy, expectedSha256: h1, sha256: h2, agentTextRunId: "x" }),
      ).resolves.toBe(false);
      await expect(row(legacy)).resolves.toEqual({ prDescriptionSha256: null, prDescriptionRunId: null });
      await expect(
        store.recordPullRequestDescription({
          rootRunId: legacy,
          expectedSha256: null,
          sha256: h2,
          agentTextRunId: "x",
        }),
      ).resolves.toBe(true);
      await expect(row(legacy)).resolves.toEqual({ prDescriptionSha256: h2, prDescriptionRunId: "x" });

      // A recorded row matches only its current hash; a stale expectation (a lost race) writes nothing.
      await expect(
        store.recordPullRequestDescription({
          rootRunId: recorded,
          expectedSha256: null,
          sha256: h2,
          agentTextRunId: "y",
        }),
      ).resolves.toBe(false);
      await expect(
        store.recordPullRequestDescription({
          rootRunId: recorded,
          expectedSha256: h1,
          sha256: h2,
          agentTextRunId: "y",
        }),
      ).resolves.toBe(true);
      await expect(
        store.recordPullRequestDescription({
          rootRunId: recorded,
          expectedSha256: h1,
          sha256: h3,
          agentTextRunId: "z",
        }),
      ).resolves.toBe(false);
      await expect(row(recorded)).resolves.toEqual({ prDescriptionSha256: h2, prDescriptionRunId: "y" });
    } finally {
      await db.codingRun.deleteMany({ where: { runId: { in: [legacy, recorded] } } });
      await db.run.deleteMany({ where: { id: { in: [legacy, recorded] } } });
    }
  });

  it("pullRequestDescriptionBaseline reads the root's hash and the author run's stored summary", async () => {
    const root = `container-desc-root-${randomUUID()}`;
    const author = `container-desc-author-${randomUUID()}`;
    const legacy = `container-desc-legacy-${randomUUID()}`;
    const hash = "4".repeat(64);
    try {
      await codingRunWith(author, "Fix round text.");
      await codingRunWith(root, "Root text.", { prDescriptionSha256: hash, prDescriptionRunId: author });
      await codingRunWith(legacy, "Legacy text.");
      const store = new PrismaContainerExecutionStore(db);
      await expect(store.pullRequestDescriptionBaseline(root)).resolves.toEqual({
        recordedSha256: hash,
        previousAgentText: "Fix round text.",
        agentTextRunId: author,
      });
      await expect(store.pullRequestDescriptionBaseline(legacy)).resolves.toEqual({
        recordedSha256: null,
        previousAgentText: "Legacy text.",
        agentTextRunId: legacy,
      });
    } finally {
      await db.codingRun.deleteMany({ where: { runId: { in: [root, author, legacy] } } });
      await db.run.deleteMany({ where: { id: { in: [root, author, legacy] } } });
    }
  });

  it("complete records the outcome on the run, and a fresh run's written hash on its own row", async () => {
    const fresh = `container-desc-fresh-${randomUUID()}`;
    const round = `container-desc-round-${randomUUID()}`;
    try {
      for (const runId of [fresh, round]) {
        await db.run.create({ data: { id: runId, agentId, executionManaged: true, status: "running" } });
        await db.codingRun.create({
          data: {
            runId,
            task: "Fix it.",
            repository: "openai/example",
            baseRef: "main",
            headRef: `wardby/run-${runId}`,
            provider: "codex",
            model: "gpt-5.6-luna",
            timeoutSec: 900,
            allowedEgress: [],
            protectedPaths: ["CODEOWNERS"],
            budgetReservedUsd: 1,
          },
        });
      }
      const store = new PrismaContainerExecutionStore(db);
      const result = (runId: string) => ({
        schemaVersion: 1 as const,
        outcome: "no_changes" as const,
        repository: "openai/example",
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        summary: "Done.",
        tests: [],
        usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      });
      const hash = "5".repeat(64);
      await store.complete(fresh, "succeeded", result(fresh), {
        prDescriptionOutcome: "written",
        prDescriptionSha256: hash,
        prDescriptionRunId: fresh,
      });
      await store.complete(round, "succeeded", result(round), { prDescriptionOutcome: "edited_by_hand" });
      const select = { prDescriptionSha256: true, prDescriptionRunId: true, prDescriptionOutcome: true };
      await expect(db.codingRun.findUniqueOrThrow({ where: { runId: fresh }, select })).resolves.toEqual({
        prDescriptionSha256: hash,
        prDescriptionRunId: fresh,
        prDescriptionOutcome: "written",
      });
      await expect(db.codingRun.findUniqueOrThrow({ where: { runId: round }, select })).resolves.toEqual({
        prDescriptionSha256: null,
        prDescriptionRunId: null,
        prDescriptionOutcome: "edited_by_hand",
      });
    } finally {
      await db.codingRun.deleteMany({ where: { runId: { in: [fresh, round] } } });
      await db.run.deleteMany({ where: { id: { in: [fresh, round] } } });
    }
  });
});
