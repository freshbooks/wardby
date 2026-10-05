/**
 * The pull requests that came from the same request as a run: every pull
 * request opened by a coding run in the same top-level run tree (a lead that
 * fanned out to several repositories), plus any recorded for the same tracker
 * issue (IssuePullRequest). Control-plane rows only. Ordered by when each
 * pull request's coding run was dispatched — the lead's delegation order,
 * since a native run's tool calls run one after another.
 */
import { Prisma, type PrismaClient } from "#prisma";
import { CODING_CODE_PROVIDER, normalizeGitHubRepository } from "../coding/protocol.js";
import { ISSUE_KEY } from "../providers/issue-tracker/types.js";
import { pullRequestOutcome } from "./host-status.js";

/** Most pull requests a group holds; the description shows fewer (MAX_RELATED_PULL_REQUESTS). */
export const MAX_RELATED_GROUP = 50;
/** Most coding runs read per tree walk. */
const MAX_TREE_CODING_RUNS = 200;

export type RelatedPullRequestsDb = Pick<PrismaClient, "run" | "codingRun" | "issuePullRequest" | "$queryRaw">;

export type StoredPullRequestState = "open" | "merged" | "closed";
const STORED_STATES = new Set<string>(["open", "merged", "closed"]);

export interface RelatedPullRequest {
  repository: string;
  number: number;
  openedAt: Date;
  /** The coding run that opened it: the continuePriorRun target for a follow-up. */
  openedByRunId: string;
  /** Only when stored (IssuePullRequest.state, kept current by pr_closed); otherwise unknown. */
  state?: StoredPullRequestState;
}

export interface RelatedPullRequestGroup {
  pullRequests: RelatedPullRequest[];
  /** The first well-formed issue seen on the group's coding runs. */
  issue?: { provider: string; key: string };
}

interface TreeCodingRun {
  runId: string;
  result: unknown;
  rootCodingRunId: string | null;
  issueProvider: string | null;
  issueKey: string | null;
  startedAt: Date;
}

/** Every coding run in the top-level trees containing `seeds` (walks up parentRunId, then down). */
async function treeCodingRuns(db: RelatedPullRequestsDb, seeds: string[]): Promise<TreeCodingRun[]> {
  return db.$queryRaw<TreeCodingRun[]>`
    WITH RECURSIVE up AS (
      SELECT r."id", r."parentRunId" FROM "Run" r WHERE r."id" IN (${Prisma.join(seeds)})
      -- UNION, not UNION ALL: a parentRunId cycle (never written, but not a constraint) can't recurse forever.
      UNION
      SELECT p."id", p."parentRunId" FROM "Run" p JOIN up u ON p."id" = u."parentRunId"
    ), down AS (
      SELECT u."id" FROM up u WHERE u."parentRunId" IS NULL
      UNION
      SELECT c."id" FROM "Run" c JOIN down d ON c."parentRunId" = d."id"
    )
    SELECT cr."runId", cr."result", cr."rootCodingRunId", cr."issueProvider", cr."issueKey", r."startedAt"
    FROM "CodingRun" cr
    JOIN down d ON cr."runId" = d."id"
    JOIN "Run" r ON r."id" = cr."runId"
    ORDER BY r."startedAt" ASC, cr."runId" ASC
    LIMIT ${MAX_TREE_CODING_RUNS}`;
}

function safeRepository(value: string): string | undefined {
  try {
    return normalizeGitHubRepository(value);
  } catch {
    return undefined;
  }
}

export async function collectRelatedPullRequests(
  db: RelatedPullRequestsDb,
  runId: string,
): Promise<RelatedPullRequestGroup> {
  const rows = await treeCodingRuns(db, [runId]);
  const seen = new Set(rows.map((r) => r.runId));
  // A continuation's pull request belongs to the request that opened it: walk that tree too.
  const roots = [
    ...new Set(
      rows.flatMap((r) =>
        pullRequestOutcome(r.result)?.outcome === "pull_request_updated" &&
        r.rootCodingRunId &&
        !seen.has(r.rootCodingRunId)
          ? [r.rootCodingRunId]
          : [],
      ),
    ),
  ];
  if (roots.length > 0) {
    for (const extra of await treeCodingRuns(db, roots)) {
      if (!seen.has(extra.runId)) {
        seen.add(extra.runId);
        rows.push(extra);
      }
    }
  }

  const byKey = new Map<string, RelatedPullRequest>();
  const keyOf = (repository: string, number: number) => `${repository}#${number}`;
  let issue: RelatedPullRequestGroup["issue"];
  const issues = new Map<string, { provider: string; key: string }>();
  for (const r of rows) {
    if (r.issueProvider && r.issueKey && ISSUE_KEY.test(r.issueKey)) {
      const found = { provider: r.issueProvider, key: r.issueKey };
      issue ??= found;
      issues.set(`${found.provider}\0${found.key}`, found);
    }
    const pr = pullRequestOutcome(r.result);
    if (pr?.outcome !== "pull_request_opened") continue;
    const repository = safeRepository(pr.repository);
    if (repository && !byKey.has(keyOf(repository, pr.pullRequestNumber))) {
      byKey.set(keyOf(repository, pr.pullRequestNumber), {
        repository,
        number: pr.pullRequestNumber,
        openedAt: new Date(r.startedAt),
        openedByRunId: r.runId,
      });
    }
  }
  if (issues.size > 0) {
    const recorded = await db.issuePullRequest.findMany({
      where: {
        codeProvider: CODING_CODE_PROVIDER,
        OR: [...issues.values()].map((i) => ({ issueProvider: i.provider, issueKey: i.key })),
      },
      select: { repository: true, number: true, createdAt: true, openedByRunId: true, state: true },
      orderBy: { createdAt: "asc" },
      take: MAX_RELATED_GROUP,
    });
    // Every pull request recorded for the issue, merged and closed included (Decision 2).
    for (const r of recorded) {
      const repository = safeRepository(r.repository);
      if (!repository || !Number.isSafeInteger(r.number) || r.number <= 0) continue;
      const state = STORED_STATES.has(r.state) ? (r.state as StoredPullRequestState) : undefined;
      const existing = byKey.get(keyOf(repository, r.number));
      if (existing) {
        // The tree's own opener and dispatch time stay; the stored state is added.
        if (state) existing.state = state;
        continue;
      }
      byKey.set(keyOf(repository, r.number), {
        repository,
        number: r.number,
        openedAt: r.createdAt,
        openedByRunId: r.openedByRunId,
        ...(state ? { state } : {}),
      });
    }
  }
  const pullRequests = [...byKey.values()]
    .sort(
      (a, b) =>
        a.openedAt.getTime() - b.openedAt.getTime() ||
        `${a.repository}#${a.number}`.localeCompare(`${b.repository}#${b.number}`),
    )
    .slice(0, MAX_RELATED_GROUP);
  return { pullRequests, ...(issue ? { issue } : {}) };
}
