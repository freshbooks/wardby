# MySQL Phase 3: MySQL dialect and event bus

**Spec:** `.claude/thoughts/investigations/2026-10-09-mysql-core-database-spec.md`
**Jira:** none yet
**Depends on:** Phase 1 (seam) and Phase 2 (schema, generated client) complete

---

## Overview

Implement `dialect-mysql.ts`, the MySQL client construction with version/privilege guard and Json-array normalization, the MySQL error classifiers, and the outbox-polling event bus. After this phase wardby runs on MySQL 8.4 end to end (deploy and quickstart wiring follow in Phase 4).

## Current State Analysis

After Phases 1–2: all divergent SQL is behind `Dialect`; `prisma/mysql/` and `src/generated/prisma-mysql` exist; `createPrismaClient` rejects non-Postgres schemes with the standard error. Postgres behaviours to reproduce are in investigation §4 (SQL), §5 (bus), §6 (errors), §7 (locks).

### Key Discoveries
- Dispatch needs its lock as the **first statement** of a Serializable transaction (`dispatch.ts:572`, rationale `:232-243`): on MySQL the `AdvisoryLock` `SELECT … FOR UPDATE` plays that role.
- No `RETURNING` on MySQL: lease and rate limiter must read back inside the same transaction (`LAST_INSERT_ID(expr)` trick for counters; `ROW_COUNT()` for the lease).
- `grants-cli` must keep working against a schema the client does not match (`ReportDb` only needs `$queryRaw`).

## Changes Required

- [ ] **Client construction and server guard** (`src/core/db.ts`, `src/core/db/mysql-client.ts`)
  - Verify: `DATABASE_URL=mysql://… npx vitest run src/core/db.test.ts`
  - Files: those two
  `createPrismaClient` builds `new PrismaMariaDb({ … from URL …, initSql: "SET SESSION sql_mode=CONCAT(@@sql_mode,',ANSI_QUOTES'), time_zone='+00:00'" , connectionLimit, connectTimeout })`, honoring the same `connection_limit`/`pool_timeout` URL params as `poolSettings`. `checkServer(db)` runs `SELECT VERSION()` and fails with "wardby requires MySQL 8.4 or later (found X)", then verifies `AdvisoryLock` and `ViewerEvent` exist. Result is wrapped with the Json↔`string[]` `$extends` for the 12 fields and cast to the Postgres `PrismaClient` type (spec Decision 6; Phase 0 A4 decides the exact cast).

- [ ] **Locks and timeouts** (`src/core/db/dialect-mysql.ts`)
  - Verify: `DATABASE_URL=mysql://… npx vitest run src/core/lease.test.ts src/core/dispatch.test.ts src/core/coding-concurrency.database.test.ts`
  - Files: `src/core/db/dialect-mysql.ts`
  ```ts
  async advisoryXactLock(tx, key) {
    const k = lockKeyString(key);
    await tx.$executeRaw`INSERT IGNORE INTO "AdvisoryLock" ("key") VALUES (${k})`;
    await tx.$queryRaw`SELECT "key" FROM "AdvisoryLock" WHERE "key" = ${k} FOR UPDATE`;
  }
  lockBudgetGroupDispatch(tx) { return this.advisoryXactLock(tx, "budget-group-dispatch"); }
  async lockAgentRowSkipLocked(tx, id) { /* SELECT "id" FROM "Agent" WHERE "id"=? FOR UPDATE SKIP LOCKED */ }
  ```
  `setLockTimeout` sets `innodb_lock_wait_timeout` for the session and registers a restore on the transaction’s connection (no `SET LOCAL` in MySQL). `beginReadOnlyWithTimeout` uses `SET TRANSACTION READ ONLY` where the cost report starts its transaction (before first statement) and `SET SESSION MAX_EXECUTION_TIME=30000` restored afterward.

- [ ] **Lease, rate limiter, counters** (`src/core/db/dialect-mysql.ts`)
  - Verify: `DATABASE_URL=mysql://… npx vitest run src/core/lease.test.ts src/mcp/auth/self-hosted`
  - Files: same file
  Lease: `INSERT … ON DUPLICATE KEY UPDATE holder = IF(expiresAt < NOW(3) OR holder = VALUES(holder), VALUES(holder), holder), expiresAt = IF(…)` (row alias form on 8.4), then `SELECT holder` and compare to the caller. Rate limit: `ON DUPLICATE KEY UPDATE hits = LAST_INSERT_ID(hits + 1)`; new row path uses 1; read `LAST_INSERT_ID()` in the same session via the transaction.

- [ ] **Queries** (`src/core/db/dialect-mysql.ts`)
  - Verify: `DATABASE_URL=mysql://… npx vitest run src/core/issue-status.database.test.ts src/core/cost-report.database.test.ts src/core/related-pull-requests.database.test.ts src/core/secrets.database.test.ts`
  - Files: same file
  `WITH RECURSIVE … UNION` is supported on 8.4 (unchanged). `FILTER (WHERE …)` → `SUM(CASE WHEN … THEN … END)`, `COUNT(DISTINCT CASE WHEN … THEN id END)`. `NULLS LAST` → `ORDER BY expr IS NULL, expr DESC`. `::text` → `CAST(… AS CHAR)`. `octet_length` → `OCTET_LENGTH`. `starts_with(k, p)` → `LEFT(k, CHAR_LENGTH(p)) = p` with `COLLATE utf8mb4_0900_bin`. Value size guard over JSON: `OCTET_LENGTH(CAST("value" AS CHAR))`. Preserve result column names and BigInt/number conversions the callers do (`Number(...)`).

- [ ] **Ledger statements** (`src/core/db/dialect-mysql.ts` or `src/providers/coding-proxy/ledger-mysql.ts`)
  - Verify: `DATABASE_URL=mysql://… npx vitest run src/providers/coding-proxy/prisma-ledger.database.test.ts`
  - Files: those
  `FOR UPDATE` session/request locks unchanged. `UPDATE "Run" AS r SET … FROM (…) RETURNING` → `UPDATE "Run" r JOIN (…) totals ON … SET …` then re-select ids. `SAVEPOINT`/`RELEASE`/`ROLLBACK TO` are supported by InnoDB (unchanged). `::jsonb` casts dropped (JSON bind via `CAST(? AS JSON)`). `ON CONFLICT … DO UPDATE` → `ON DUPLICATE KEY UPDATE` with the same arithmetic.

- [ ] **Memory and datastore** (`src/providers/memory/postgres.ts`, `src/providers/datastore/postgres.ts`, `src/core/db/dialect-mysql.ts`)
  - Verify: `DATABASE_URL=mysql://… npx vitest run src/providers/memory src/providers/datastore`
  - Files: those three
  Memory `set`: the key-cap `INSERT … SELECT … WHERE (SELECT COUNT(*) …) < cap OR EXISTS(…)` then `ON DUPLICATE KEY UPDATE`; affected-rows 0 → `memory_limit_exceeded` as today. `search`: `MATCH(content) AGAINST (? IN NATURAL LANGUAGE MODE)` as `rank`, filtered to the agent, `ORDER BY rank DESC LIMIT n`. Datastore size guards and prefix listing per the Queries task.

- [ ] **Auth and OAuth locking, grants report** (`src/providers/auth/self-hosted.ts`, `src/mcp/auth/self-hosted/credentials.ts`, `src/mcp/auth/grants-cli.ts`)
  - Verify: `DATABASE_URL=mysql://… npx vitest run src/providers/auth src/mcp/auth`
  - Files: those three (dialect methods)
  Row locks `SELECT … FOR UPDATE` identical syntax; positional params `?`. Grants report: `to_regclass` → `information_schema.tables` check on `DATABASE()`; `information_schema.columns` with `table_schema = DATABASE()`; `IS DISTINCT FROM` → `NOT (a <=> b)`; `||` → `CONCAT()`.

- [ ] **Error classifiers** (`src/core/db/dialect-mysql.ts`, `src/mcp/errors.ts`)
  - Verify: `DATABASE_URL=mysql://… npx vitest run src/core/prisma-adapter.database.test.ts`
  - Files: those two
  Use the shapes recorded in Phase 0 (A5, A6): serialization conflict = Prisma `P2034`, or driver error SQLSTATE `40001`/errno 1213 (deadlock) or errno 1205 (lock wait timeout) at statement or COMMIT; `isLockTimeout` = errno 1205; unique violation errno 1062 → fields from `cause.constraint` or index name parsing `<Model>_<field>_key`; FK errno 1451/1452 map to the existing P2003 branches.

- [ ] **Outbox polling event bus** (`src/viewer/event-bus-mysql.ts`, `src/core/db/dialect-mysql.ts`)
  - Verify: `DATABASE_URL=mysql://… npx vitest run src/viewer`
  - Files: `src/viewer/event-bus-mysql.ts` (+ test `event-bus-mysql.test.ts`)
  Same `ViewerEventBus` interface and validation (`ViewerEventSchema`). Lazy start on first subscriber; cursor initialised to `SELECT COALESCE(MAX(id),0)`; poll every `VIEWER_POLL_INTERVAL_MS` (default 1000) with `LIMIT 500`; `onState(true)` after first successful poll and after recovery (plus `resync` via existing `http.ts` path); `onState(false)` and throttled warning on failure; prune `DELETE FROM "ViewerEvent" WHERE "createdAt" < NOW(3) - INTERVAL 10 MINUTE` at most once per minute per replica; timers `unref`'d; clean shutdown.

- [ ] **Remaining Prisma-model call sites** (`src/core/review-fix.ts` and any found by the MySQL test run)
  - Verify: `DATABASE_URL=mysql://… npm test`
  - Files: as found — list-field filters go through `dialect.listFilter` (`{ path: "$", array_contains: "review_fix" }` on MySQL); any other model-API behaviour that differs (case sensitivity, ordering, BigInt) is fixed in the dialect or normalizer, not by weakening tests.

## Success Criteria

### Automated Verification:
- [ ] `DATABASE_URL=mysql://… npm test` passes (Postgres-only tests excluded in Phase 5).
- [ ] `DATABASE_URL=postgresql://… npm test` still passes.
- [ ] Concurrency tests pass on MySQL: lease race (one leader), dispatch budget-group race (no overspend), OAuth capacity, coding-slot cap.
- [ ] `npm run typecheck && npm run lint && npm run build`

### Manual Verification:
- [ ] Run the server on MySQL; start a run; confirm viewer events arrive within ~2 s and survive killing and restarting MySQL (status false then resync).
- [ ] Confirm a Postgres run is unchanged.

**Implementation Note**: pause for confirmation before Phase 4.

## References
- Spec decisions 4–8
- Investigation §4–§7
- Postgres originals: `src/core/lease.ts:16-27`, `src/core/dispatch.ts:232-244,539-789`, `src/viewer/event-bus.ts:44-253`
