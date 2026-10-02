/**
 * Cost attribution (docs/private/2026-10-01-issue-cost-attribution-design.md):
 * every run in an issue-related run tree points at one WorkItem, with the
 * item's parent frozen as of dispatch. Attribution comes from control-plane
 * data only (the event, a stored PR link, a validated explicit key, or the
 * parent run), never from model output. A snapshot is a network call, so it
 * is taken before dispatch's persist transaction and never fails a dispatch.
 */
import type { Prisma, PrismaClient } from "#prisma";
import {
  projectOf,
  type IssueSnapshot,
  type IssueTrackerProvider,
  type IssueTrackerRegistry,
} from "../providers/issue-tracker/types.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "attribution" });

export type AttributionSource = "issue_event" | "linked_pr" | "explicit";

/** Resolved before the persist transaction; never contains a network call. */
export interface ResolvedWorkItem {
  provider: string;
  key: string;
  scopeKey: string;
  /** null = key-only (snapshot failed or no tracker); then existing WorkItem fields are kept. */
  snapshot: IssueSnapshot | null;
}

export interface AttributionIntent {
  source: AttributionSource;
  item: ResolvedWorkItem;
}

/** A WorkItem snapshotted this recently is reused as-is, without calling the tracker. */
export const SNAPSHOT_CACHE_MS = 10 * 60 * 1000;
export const SNAPSHOT_TIMEOUT_MS = 3000;

/**
 * The work item a new attribution points at, snapshotted from the tracker
 * unless a fresh snapshot is already stored. Never throws: a failed lookup or
 * snapshot attributes by key only.
 */
export async function resolveWorkItem(
  db: Pick<PrismaClient, "workItem">,
  trackers: IssueTrackerRegistry | undefined,
  provider: string,
  key: string,
  opts: { timeoutMs?: number; retryOn429?: boolean; now?: Date } = {},
): Promise<ResolvedWorkItem> {
  const now = opts.now ?? new Date();
  const keyOnly = (scopeKey = projectOf(key)): ResolvedWorkItem => ({ provider, key, scopeKey, snapshot: null });
  let existing: { refreshedAt: Date | null; scopeKey: string } | null;
  try {
    existing = await db.workItem.findUnique({
      where: { provider_key: { provider, key } },
      select: { refreshedAt: true, scopeKey: true },
    });
  } catch (err) {
    log.warn({ err, provider, key }, "work item lookup failed; attributing by key only");
    return keyOnly();
  }
  if (existing?.refreshedAt && now.getTime() - existing.refreshedAt.getTime() < SNAPSHOT_CACHE_MS) {
    return keyOnly(existing.scopeKey);
  }
  const tracker = trackers?.[provider as IssueTrackerProvider];
  if (!tracker) return keyOnly(existing?.scopeKey);
  try {
    const snapshot = await tracker.snapshotIssue(key, {
      timeoutMs: opts.timeoutMs ?? SNAPSHOT_TIMEOUT_MS,
      retryOn429: opts.retryOn429,
    });
    return { provider, key, scopeKey: snapshot.scopeKey, snapshot };
  } catch (err) {
    log.warn({ err, provider, key }, "issue snapshot failed; attributing by key only");
    return keyOnly(existing?.scopeKey);
  }
}

export type AttributionTx = Pick<
  Prisma.TransactionClient,
  "workItem" | "runAttribution" | "codingRun" | "runIssueStatus"
>;

/** Upserts the item (and its parent) and returns the item's id and the parent to freeze. A key-only result never clobbers stored fields. */
async function upsertWorkItem(
  tx: AttributionTx,
  item: ResolvedWorkItem,
  now: Date,
): Promise<{ id: string; parentKey: string | null }> {
  const s = item.snapshot;
  if (s?.parent) {
    // The parent's own type/scope/title are refreshed when it is snapshotted itself; here only make sure it exists
    // and take a title we were handed for free.
    await tx.workItem.upsert({
      where: { provider_key: { provider: item.provider, key: s.parent.key } },
      create: {
        provider: item.provider,
        key: s.parent.key,
        scopeKey: projectOf(s.parent.key),
        ...(s.parent.title ? { title: s.parent.title } : {}),
      },
      update: s.parent.title ? { title: s.parent.title } : {},
    });
  }
  const snapshotFields = s
    ? {
        title: s.title ?? null,
        type: s.type ?? null,
        url: s.url,
        scopeKey: s.scopeKey,
        parentKey: s.parent?.key ?? null,
        parentKind: s.parent?.kind ?? null,
        refreshedAt: now,
      }
    : {};
  const row = await tx.workItem.upsert({
    where: { provider_key: { provider: item.provider, key: item.key } },
    create: { provider: item.provider, key: item.key, scopeKey: item.scopeKey, ...snapshotFields },
    update: snapshotFields,
    select: { id: true, parentKey: true },
  });
  return row;
}

/**
 * Covers runs created before attribution existed (no backfill): a continued
 * coding run that already carries CodingRun.issueKey, else a direct parent
 * with a RunIssueStatus. Grandchildren then inherit the child's new
 * RunAttribution, so only the direct parent is checked.
 */
async function legacyIssue(
  tx: AttributionTx,
  from: { parentRunId?: string; continuesCodingRunId?: string },
): Promise<{ provider: string; key: string } | null> {
  if (from.continuesCodingRunId) {
    const prior = await tx.codingRun.findUnique({
      where: { runId: from.continuesCodingRunId },
      select: { issueProvider: true, issueKey: true },
    });
    if (prior?.issueProvider && prior.issueKey) return { provider: prior.issueProvider, key: prior.issueKey };
  }
  if (from.parentRunId) {
    const status = await tx.runIssueStatus.findUnique({
      where: { runId: from.parentRunId },
      select: { provider: true, issueKey: true },
    });
    if (status) return { provider: status.provider, key: status.issueKey };
  }
  return null;
}

/**
 * Writes the run's attribution inside dispatch's persist transaction.
 * Precedence: the parent run's attribution, then the continued coding run's,
 * then a pre-attribution issue (legacyIssue), then the caller's intent. Returns the item's provider/key (for
 * CodingRun.issueProvider/issueKey), or null when the run is unattributed.
 */
export async function attributeRun(
  tx: AttributionTx,
  runId: string,
  from: { parentRunId?: string; continuesCodingRunId?: string; intent?: AttributionIntent },
  now: Date = new Date(),
): Promise<{ provider: string; key: string } | null> {
  for (const ancestorId of [from.parentRunId, from.continuesCodingRunId]) {
    if (!ancestorId) continue;
    const inherited = await tx.runAttribution.findUnique({
      where: { runId: ancestorId },
      select: { workItemId: true, parentKeyAtRun: true, workItem: { select: { provider: true, key: true } } },
    });
    if (!inherited) continue;
    await tx.runAttribution.create({
      data: { runId, workItemId: inherited.workItemId, parentKeyAtRun: inherited.parentKeyAtRun, source: "inherited" },
    });
    return { provider: inherited.workItem.provider, key: inherited.workItem.key };
  }
  const legacy = await legacyIssue(tx, from);
  if (legacy) {
    const item = { ...legacy, scopeKey: projectOf(legacy.key), snapshot: null };
    const { id, parentKey } = await upsertWorkItem(tx, item, now);
    await tx.runAttribution.create({ data: { runId, workItemId: id, parentKeyAtRun: parentKey, source: "inherited" } });
    return legacy;
  }
  if (!from.intent) return null;
  const { id, parentKey } = await upsertWorkItem(tx, from.intent.item, now);
  await tx.runAttribution.create({
    data: { runId, workItemId: id, parentKeyAtRun: parentKey, source: from.intent.source },
  });
  return { provider: from.intent.item.provider, key: from.intent.item.key };
}
