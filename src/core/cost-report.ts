/**
 * Cost by issue / parent / scope / agent / model / run over a time window
 * (docs/private/2026-10-01-issue-cost-attribution-design.md §7). Rows count
 * attributed runs only; unattributed spend is reported separately so the gap
 * is visible. Money is summed as NUMERIC in SQL and returned as strings; tokens
 * are always by priced kind, never one total.
 */
import { Prisma, type PrismaClient } from "#prisma";

export type CostGroupBy = "issue" | "parent" | "scope" | "agent" | "model" | "run";
const GROUP_BYS: readonly CostGroupBy[] = ["issue", "parent", "scope", "agent", "model", "run"];
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

export class CostReportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostReportInputError";
  }
}

export interface CostReportQuery {
  groupBy: CostGroupBy;
  from: Date;
  to: Date;
  provider?: string;
  scopeKey?: string;
  parentKey?: string;
  issueKey?: string;
  agentId?: string;
  limit: number;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length === 0 || v.length > 256) {
    throw new CostReportInputError(`${name} must be a non-empty string.`);
  }
  return v;
}

function optionalDate(args: Record<string, unknown>, name: string): Date | undefined {
  const v = args[name];
  if (v === undefined) return undefined;
  const d = typeof v === "string" ? new Date(v) : new Date(NaN);
  if (Number.isNaN(d.getTime())) throw new CostReportInputError(`${name} must be an ISO date.`);
  return d;
}

export function parseCostReportQuery(raw: unknown, now: Date = new Date()): CostReportQuery {
  const args = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const groupBy = (args.groupBy ?? "issue") as CostGroupBy;
  if (!GROUP_BYS.includes(groupBy)) {
    throw new CostReportInputError(`groupBy must be one of: ${GROUP_BYS.join(", ")}.`);
  }
  const to = optionalDate(args, "to") ?? now;
  const from = optionalDate(args, "from") ?? new Date(to.getTime() - DEFAULT_WINDOW_MS);
  if (from.getTime() >= to.getTime()) throw new CostReportInputError("from must be before to.");
  let limit = DEFAULT_LIMIT;
  if (args.limit !== undefined) {
    if (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1) {
      throw new CostReportInputError("limit must be a positive integer.");
    }
    limit = Math.min(args.limit, MAX_LIMIT);
  }
  const q: CostReportQuery = { groupBy, from, to, limit };
  for (const name of ["provider", "scopeKey", "parentKey", "issueKey", "agentId"] as const) {
    const v = optionalString(args, name);
    if (v !== undefined) q[name] = v;
  }
  return q;
}

/** Which runs the caller may count: null = all (stdio operator). */
export interface CostVisibility {
  ownedAgentIds: string[];
  principalId: string;
}

export interface TokenKinds {
  freshInput: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

export interface CostRow {
  key: string;
  title: string | null;
  kind: string | null;
  provider: string | null;
  runs: number;
  inProgressRuns: number;
  costUsd: string;
  tokens: TokenKinds;
  byModel: Array<{ model: string; costUsd: string; tokens: TokenKinds }>;
  bySource: { issue_event: string; linked_pr: string; explicit: string; inherited: string };
  firstRunAt: string;
  lastRunAt: string;
}

export interface CostReport {
  currency: "USD";
  groupBy: CostGroupBy;
  from: string;
  to: string;
  rows: CostRow[];
  truncated: boolean;
  totals: { runs: number; costUsd: string; tokens: TokenKinds };
  unattributed: { runs: number; costUsd: string };
}

const NO_PARENT = "(no parent)";

/** NUMERIC text → canonical decimal string without trailing zeros ("3.100000" → "3.1", null → "0"). */
function usd(v: string | null | undefined): string {
  if (v == null) return "0";
  return v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v;
}

type TokenSums = {
  fresh: bigint | number | null;
  cached: bigint | number | null;
  write: bigint | number | null;
  out: bigint | number | null;
};

const kinds = (r: TokenSums | undefined): TokenKinds => ({
  freshInput: Number(r?.fresh ?? 0),
  cachedInput: Number(r?.cached ?? 0),
  cacheWrite: Number(r?.write ?? 0),
  output: Number(r?.out ?? 0),
});

/** The run filter every query shares: window, visibility, and the agent filter. Only `r` must be in scope. */
function runFilter(q: CostReportQuery, vis: CostVisibility | null): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`r."startedAt" >= ${q.from} AND r."startedAt" < ${q.to}`];
  if (vis) {
    parts.push(
      vis.ownedAgentIds.length > 0
        ? Prisma.sql`(r."agentId" IN (${Prisma.join(vis.ownedAgentIds)}) OR r."triggeredById" = ${vis.principalId})`
        : Prisma.sql`r."triggeredById" = ${vis.principalId}`,
    );
  }
  if (q.agentId) parts.push(Prisma.sql`r."agentId" = ${q.agentId}`);
  return Prisma.join(parts, " AND ");
}

/** The work-item filters; `a` (RunAttribution) and `w` (WorkItem) must be joined. */
function attributionFilter(q: CostReportQuery): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (q.provider) parts.push(Prisma.sql`w."provider" = ${q.provider}`);
  if (q.scopeKey) parts.push(Prisma.sql`w."scopeKey" = ${q.scopeKey}`);
  if (q.parentKey) parts.push(Prisma.sql`a."parentKeyAtRun" = ${q.parentKey}`);
  if (q.issueKey) parts.push(Prisma.sql`w."key" = ${q.issueKey}`);
  return Prisma.join(parts, " AND ");
}

/** The group key for each groupBy, over Run r / RunAttribution a / WorkItem w (and RunModelUsage u for "model"). */
const GROUP_KEY: Record<CostGroupBy, Prisma.Sql> = {
  issue: Prisma.sql`w."key"`,
  parent: Prisma.sql`COALESCE(a."parentKeyAtRun", '(no parent)')`,
  scope: Prisma.sql`w."scopeKey"`,
  agent: Prisma.sql`r."agentId"`,
  model: Prisma.sql`u."model"`,
  run: Prisma.sql`r."id"`,
};

const ATTRIBUTED = Prisma.sql`"Run" r JOIN "RunAttribution" a ON a."runId" = r."id" JOIN "WorkItem" w ON w."id" = a."workItemId"`;
const USAGE_ATTRIBUTED = Prisma.sql`"RunModelUsage" u JOIN ${ATTRIBUTED} ON r."id" = u."runId"`;

interface GroupRow {
  key: string;
  provider: string | null;
  parent_kind: string | null;
  runs: bigint;
  in_progress: bigint;
  usd: string | null;
  src_issue_event: string | null;
  src_linked_pr: string | null;
  src_explicit: string | null;
  src_inherited: string | null;
  first_at: Date;
  last_at: Date;
}

export async function costReport(
  db: Pick<PrismaClient, "$queryRaw">,
  q: CostReportQuery,
  visibility: CostVisibility | null,
): Promise<CostReport> {
  const where = Prisma.sql`${runFilter(q, visibility)} AND ${attributionFilter(q)}`;
  const key = GROUP_KEY[q.groupBy];
  // "model" groups usage rows, so its money comes from RunModelUsage; every other grouping sums Run.costUsd once per run.
  const byModel = q.groupBy === "model";
  const money = byModel ? Prisma.sql`u."costUsd"` : Prisma.sql`r."costUsd"`;
  const source = byModel ? USAGE_ATTRIBUTED : ATTRIBUTED;

  const groups = await db.$queryRaw<GroupRow[]>`
    SELECT ${key} AS key,
           MIN(w."provider") AS provider,
           MIN(w."parentKind") AS parent_kind,
           COUNT(DISTINCT r."id") AS runs,
           COUNT(DISTINCT r."id") FILTER (WHERE r."status" IN ('pending', 'running')) AS in_progress,
           SUM(${money})::text AS usd,
           SUM(${money}) FILTER (WHERE a."source" = 'issue_event')::text AS src_issue_event,
           SUM(${money}) FILTER (WHERE a."source" = 'linked_pr')::text AS src_linked_pr,
           SUM(${money}) FILTER (WHERE a."source" = 'explicit')::text AS src_explicit,
           SUM(${money}) FILTER (WHERE a."source" = 'inherited')::text AS src_inherited,
           MIN(r."startedAt") AS first_at,
           MAX(r."startedAt") AS last_at
    FROM ${source}
    WHERE ${where}
    GROUP BY ${key}
    ORDER BY SUM(${money}) DESC NULLS LAST, ${key}
    LIMIT ${q.limit + 1}`;
  const truncated = groups.length > q.limit;
  const page = groups.slice(0, q.limit);

  // Per-group, per-model tokens and money for just this page's groups.
  const usage = page.length
    ? await db.$queryRaw<Array<{ key: string; model: string; usd: string | null } & TokenSums>>`
        SELECT ${key} AS key, u."model" AS model, SUM(u."costUsd")::text AS usd,
               SUM(u."freshInputTokens") AS fresh, SUM(u."cachedInputTokens") AS cached,
               SUM(u."cacheWriteTokens") AS write, SUM(u."outputTokens") AS out
        FROM ${USAGE_ATTRIBUTED}
        WHERE ${where} AND ${key} IN (${Prisma.join(page.map((g) => g.key))})
        GROUP BY ${key}, u."model"
        ORDER BY SUM(u."costUsd") DESC, u."model"`
    : [];

  const titles = await groupTitles(db, q.groupBy, page);

  const rows: CostRow[] = page.map((g) => {
    const models = usage
      .filter((u) => u.key === g.key)
      .map((m) => ({ model: m.model, costUsd: usd(m.usd), tokens: kinds(m) }));
    const tokens = models.reduce<TokenKinds>(
      (t, m) => ({
        freshInput: t.freshInput + m.tokens.freshInput,
        cachedInput: t.cachedInput + m.tokens.cachedInput,
        cacheWrite: t.cacheWrite + m.tokens.cacheWrite,
        output: t.output + m.tokens.output,
      }),
      { freshInput: 0, cachedInput: 0, cacheWrite: 0, output: 0 },
    );
    return {
      key: g.key,
      ...titles(g),
      provider: g.provider,
      runs: Number(g.runs),
      inProgressRuns: Number(g.in_progress),
      costUsd: usd(g.usd),
      tokens,
      byModel: models,
      bySource: {
        issue_event: usd(g.src_issue_event),
        linked_pr: usd(g.src_linked_pr),
        explicit: usd(g.src_explicit),
        inherited: usd(g.src_inherited),
      },
      firstRunAt: g.first_at.toISOString(),
      lastRunAt: g.last_at.toISOString(),
    };
  });

  const [totals] = await db.$queryRaw<{ runs: bigint; usd: string | null }[]>`
    SELECT COUNT(*) AS runs, SUM(r."costUsd")::text AS usd FROM ${ATTRIBUTED} WHERE ${where}`;
  const [totalTokens] = await db.$queryRaw<TokenSums[]>`
    SELECT SUM(u."freshInputTokens") AS fresh, SUM(u."cachedInputTokens") AS cached,
           SUM(u."cacheWriteTokens") AS write, SUM(u."outputTokens") AS out
    FROM ${USAGE_ATTRIBUTED} WHERE ${where}`;
  const [unattributed] = await db.$queryRaw<{ runs: bigint; usd: string | null }[]>`
    SELECT COUNT(*) AS runs, SUM(r."costUsd")::text AS usd
    FROM "Run" r
    WHERE ${runFilter(q, visibility)}
      AND NOT EXISTS (SELECT 1 FROM "RunAttribution" ra WHERE ra."runId" = r."id")`;

  return {
    currency: "USD",
    groupBy: q.groupBy,
    from: q.from.toISOString(),
    to: q.to.toISOString(),
    rows,
    truncated,
    totals: { runs: Number(totals?.runs ?? 0), costUsd: usd(totals?.usd), tokens: kinds(totalTokens) },
    unattributed: { runs: Number(unattributed?.runs ?? 0), costUsd: usd(unattributed?.usd) },
  };
}

type TitleOf = (g: GroupRow) => { title: string | null; kind: string | null };

/** Titles and kinds per group: current WorkItem names for issue/parent, agent names for agent; none otherwise. */
async function groupTitles(
  db: Pick<PrismaClient, "$queryRaw">,
  groupBy: CostGroupBy,
  page: GroupRow[],
): Promise<TitleOf> {
  const none: TitleOf = () => ({ title: null, kind: null });
  if (page.length === 0) return none;
  if (groupBy === "issue" || groupBy === "parent") {
    const keys = page.map((g) => g.key).filter((k) => k !== NO_PARENT);
    if (keys.length === 0) return none;
    const items = await db.$queryRaw<{ provider: string; key: string; title: string | null; type: string | null }[]>`
      SELECT "provider", "key", "title", "type" FROM "WorkItem" WHERE "key" IN (${Prisma.join(keys)})`;
    const byKey = new Map(items.map((i) => [`${i.provider}\u0000${i.key}`, i]));
    return (g) => {
      if (groupBy === "parent" && g.key === NO_PARENT) return { title: null, kind: null };
      const i = byKey.get(`${g.provider}\u0000${g.key}`);
      // A parent's kind lives on its children (WorkItem.parentKind), selected in the group query.
      return { title: i?.title ?? null, kind: groupBy === "parent" ? g.parent_kind : (i?.type ?? null) };
    };
  }
  if (groupBy === "agent") {
    const agents = await db.$queryRaw<{ id: string; name: string }[]>`
      SELECT "id", "name" FROM "Agent" WHERE "id" IN (${Prisma.join(page.map((g) => g.key))})`;
    const byId = new Map(agents.map((a) => [a.id, a.name]));
    return (g) => ({ title: byId.get(g.key) ?? null, kind: "agent" });
  }
  return none;
}
