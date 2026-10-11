/**
 * Mark-ready's once-per-pull-request claim (CodingRun.markedReadyAt) against
 * real PostgreSQL: concurrent evaluations mark once, a later evaluation after
 * marking is final, and a host failure releases the claim. The code host is a
 * fake that reports every condition passing. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeReviewHost } from "../providers/review-host/types.js";
import { createPrismaClient } from "./db.js";
import { maybeMarkReady } from "./mark-ready.js";

describe.skipIf(!process.env.DATABASE_URL)("mark ready when passing (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID();
  const s8 = suffix.slice(0, 8);
  const id = (name: string) => `markready-${name}-${suffix}`;
  const owner = id("owner");
  const builder = id("builder");
  const reviewer = id("reviewer");
  const repository = `markready/web-${s8}`;
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  let failMark = false;
  const host = {
    provider: "github",
    pullRequestOrigin: vi.fn(async () => ({
      headSha: SHA,
      isFork: false,
      state: "open",
      labels: [],
      draft: true,
      markerRunId: id("root"),
    })),
    readOwnChecks: vi.fn(
      async () => new Map([[`wardby review ${s8}`, { status: "completed", conclusion: "success" }]]),
    ),
    readCi: vi.fn(async () => ({
      headSha: SHA,
      state: "passing",
      checks: [],
      truncated: false,
      statusesUnavailable: false,
    })),
    markReadyForReview: vi.fn(async () => {
      // Yield so a concurrent evaluation reaches its claim while this one is "on the host".
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (failMark) throw new Error("host down");
      return "marked" as const;
    }),
  } as unknown as CodeReviewHost;
  const deps = { db, hosts: { github: host } };
  const markedReadyAt = async () =>
    (await db.codingRun.findUniqueOrThrow({ where: { runId: id("root") }, select: { markedReadyAt: true } }))
      .markedReadyAt;

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    for (const a of [builder, reviewer]) {
      await db.agent.create({ data: { id: a, name: a, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner } });
    }
    await db.agentRepository.create({
      data: { agentId: builder, provider: "github", repository, access: "write", markReadyWhenPassing: true },
    });
    await db.agentRepository.create({
      data: {
        agentId: reviewer,
        provider: "github",
        repository,
        access: "write",
        triggers: ["pull_request"],
        checkName: `wardby review ${s8}`,
      },
    });
    await db.run.create({ data: { id: id("root"), agentId: builder, status: "succeeded" } });
    await db.codingRun.create({
      data: {
        runId: id("root"),
        task: "t",
        repository,
        baseRef: "main",
        headRef: `wardby/run-${id("root")}`,
        provider: "codex",
        model: "m",
        timeoutSec: 900,
        protectedPaths: [],
        budgetReservedUsd: 1,
        result: {
          outcome: "pull_request_opened",
          repository,
          pullRequestNumber: 7,
          pullRequestUrl: `https://github.com/${repository}/pull/7`,
        },
      },
    });
  });

  beforeEach(async () => {
    failMark = false;
    vi.mocked(host.markReadyForReview!).mockClear();
    await db.codingRun.update({ where: { runId: id("root") }, data: { markedReadyAt: null } });
  });

  afterAll(async () => {
    await db.codingRun.deleteMany({ where: { runId: id("root") } });
    await db.run.deleteMany({ where: { agentId: { in: [builder, reviewer] } } });
    await db.agentRepository.deleteMany({ where: { agentId: { in: [builder, reviewer] } } });
    await db.agent.deleteMany({ where: { id: { in: [builder, reviewer] } } });
    await db.principal.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  it("two concurrent evaluations of one pull request mark it exactly once", async () => {
    const outcomes = await Promise.all([maybeMarkReady(deps, repository, 7), maybeMarkReady(deps, repository, 7)]);
    expect(outcomes.sort()).toEqual(["marked", "skipped"]);
    expect(host.markReadyForReview).toHaveBeenCalledTimes(1);
    expect(await markedReadyAt()).toBeInstanceOf(Date);
  });

  it("after marking, a later evaluation of the same draft is skipped without touching the host", async () => {
    expect(await maybeMarkReady(deps, repository, 7)).toBe("marked");
    vi.mocked(host.markReadyForReview!).mockClear();
    // A person moved it back to draft: the host still reports a draft, but marking is final.
    expect(await maybeMarkReady(deps, repository, 7)).toBe("skipped");
    expect(host.markReadyForReview).not.toHaveBeenCalled();
  });

  it("a host failure releases the claim, so the next evaluation marks", async () => {
    failMark = true;
    expect(await maybeMarkReady(deps, repository, 7)).toBe("failed");
    expect(await markedReadyAt()).toBeNull();
    failMark = false;
    expect(await maybeMarkReady(deps, repository, 7)).toBe("marked");
    expect(await markedReadyAt()).toBeInstanceOf(Date);
  });
});
