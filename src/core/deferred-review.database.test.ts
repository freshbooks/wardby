/**
 * Deferred reviews (waitForCi) against real PostgreSQL: recording a deferral
 * is idempotent per head and reviewer (the unique key plus skipDuplicates),
 * and claiming by delete starts each review once even when two sweeps race.
 * Dispatch is stubbed. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CodeReviewHost } from "../providers/review-host/types.js";
import { createPrismaClient } from "./db.js";
import { DEFERRED_REVIEW_MAX_WAIT_MS, routeHostEvent, startDeferredReviews, type HostEvent } from "./host-events.js";
import type { RepoAccessGate } from "./repo-access.js";

vi.mock("./dispatch.js", () => ({
  dispatchRun: vi.fn(async (opts: { agentId: string }) => ({ run: { id: `run-${opts.agentId}-${randomUUID()}` } })),
  checkContinuation: vi.fn(),
}));
import { dispatchRun } from "./dispatch.js";

describe.skipIf(!process.env.DATABASE_URL)("deferred reviews (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID();
  const owner = `deferdb-owner-${suffix}`;
  const agentId = `deferdb-agent-${suffix}`;
  const repository = `deferdb/repo-${suffix.slice(0, 8)}`;
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  let ci = "pending";

  const host = {
    provider: "github",
    pullRequestHead: vi.fn(async () => ({ headSha: SHA, isFork: false, state: "open" })),
    readCi: vi.fn(async () => ({ headSha: SHA, state: ci, checks: [], truncated: false, statusesUnavailable: false })),
    startCheck: vi.fn(async () => ({ checkId: "1" })),
    completeCheck: vi.fn(async () => undefined),
  } as unknown as CodeReviewHost;
  const repoAccess = {
    authorizeUse: vi.fn(async () => ({ ok: true })),
    authorizeHostUser: vi.fn(async () => ({ ok: true })),
    authorizePrincipal: vi.fn(),
  } as unknown as RepoAccessGate;
  const deps = {
    db,
    executor: {} as never,
    hosts: { github: host },
    repoAccess,
    mentionHandle: "wardby",
  };
  const pushed: HostEvent = {
    kind: "pr_updated",
    provider: "github",
    repository,
    prNumber: 3,
    headSha: SHA,
    isFork: false,
  };
  const rows = () => db.deferredReview.findMany({ where: { repository } });

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner },
    });
    await db.agentRepository.create({
      data: {
        agentId,
        provider: "github",
        repository,
        access: "write",
        triggers: ["pull_request"],
        checkName: "wardby review",
        waitForCi: true,
        authorizedVia: "host_permission",
      },
    });
  });

  afterAll(async () => {
    await db.deferredReview.deleteMany({ where: { repository } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  it("records one row per head and reviewer however often the push is delivered", async () => {
    ci = "pending";
    await expect(routeHostEvent(pushed, deps)).resolves.toEqual({ runIds: [], followUps: [] });
    await expect(routeHostEvent(pushed, deps)).resolves.toEqual({ runIds: [], followUps: [] });
    expect(await rows()).toHaveLength(1);
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it("starts the review once when two sweeps race for the same row", async () => {
    vi.mocked(dispatchRun).mockClear();
    const later = new Date(Date.now() + DEFERRED_REVIEW_MAX_WAIT_MS + 60_000);
    const [a, b] = await Promise.all([startDeferredReviews(deps, later), startDeferredReviews(deps, later)]);
    expect([...a, ...b]).toHaveLength(1);
    expect(dispatchRun).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(0);
  });
});
