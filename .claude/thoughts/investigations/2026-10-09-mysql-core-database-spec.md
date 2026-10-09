# MySQL as a configurable core database — Spec

**Jira:** none yet (create a DEVXP story at ship time via the commit-and-pr flow)
**Created:** 2026-10-09
**Research:** `.claude/thoughts/investigations/2026-10-09-database-layer-postgres-coupling.md`
**Visibility:** copy of the private design doc kept under `.claude/thoughts/` (untracked). The same files exist in `docs/private/` (git-ignored). CLAUDE.md forbids committing specs and plans to tracked paths; operator-facing text produced by Phase 6 must follow "Public docs are for operators".

---

## Table of Contents

- [Overview](#overview)
- [Acceptance Criteria](#acceptance-criteria)
- [Data Model](#data-model)
- [Dependencies](#dependencies)
- [Boundaries](#boundaries)
- [Design Decisions](#design-decisions)
- [Phase Summary](#phase-summary)
- [Monitoring](#monitoring)
- [Error Handling Matrix](#error-handling-matrix)
- [Resolved Questions](#resolved-questions)
- [Open Questions](#open-questions)
- [Definition of Done](#definition-of-done)
- [Change Log](#change-log)

---

## Overview

Operators can run wardby on **PostgreSQL (default, unchanged)** or **MySQL 8.4+**, chosen by the scheme of `DATABASE_URL` (`postgresql://` or `mysql://`). All wardby features work on MySQL, with one documented exception: the optional DBOS executor keeps its state in a Postgres database, so on MySQL `EXECUTOR=dbos` requires `DBOS_SYSTEM_DATABASE_URL` pointing at a Postgres.

Customer impact: operators who cannot or will not run Postgres get a supported backend. Existing Postgres deployments see no schema, data or behaviour change. The cost is a permanent second code path: every future schema change ships two migrations, and every raw query is dialect-aware.

**In scope**
- Dialect selection from `DATABASE_URL`; both Prisma clients built and shipped.
- MySQL schema + migration chain (hand-written), drift-checked against its own schema.
- A `Dialect` seam for every Postgres-specific statement, lock, error shape and notification.
- MySQL outbox + polling for the viewer event bus.
- Local compose, quickstart, GCP Terraform (Cloud SQL for MySQL 8.4) and production compose support.
- Test suites running against both databases in CI.
- `docs/`, `help/`, README, OKF concept updates.

**Out of scope**
- MariaDB (differs on `RETURNING`, JSON, locking; not a target).
- MySQL below 8.4.
- A native durable-execution layer to replace DBOS on MySQL (separate spec if ever wanted).
- Postgres to MySQL data migration tooling.
- `deploy/aws/` (contains only `.gitkeep`; no module exists to extend).
- Redis-based event distribution.

---

## Acceptance Criteria

- [ ] **Dialect selection:** WHEN `DATABASE_URL` starts with `mysql://`, the server SHALL use the MySQL client, dialect and event bus; WHEN it starts with `postgresql://` or `postgres://`, it SHALL behave exactly as before; WHEN the scheme is anything else, startup SHALL fail with an error naming the supported schemes.
- [ ] **Version guard:** WHEN the connected MySQL server version is below 8.4, startup SHALL fail with an error stating the minimum version.
- [ ] **Schema parity:** WHEN the MySQL migration chain is replayed on an empty MySQL 8.4 database, `prisma migrate diff --from-migrations prisma/mysql/migrations --to-schema prisma/mysql/schema.prisma --exit-code` SHALL report an empty migration, and the Postgres drift check SHALL remain clean.
- [ ] **Postgres untouched:** WHEN the existing Postgres migrations are checksummed before and after the change, they SHALL be byte-identical, and the full existing test suite SHALL pass on Postgres without edits to test expectations.
- [ ] **Feature parity:** WHEN the `*.database.test.ts` suites and the DB-gated tests run against MySQL 8.4, they SHALL pass, except tests explicitly marked Postgres-only (`LISTEN/NOTIFY`, `tsvector`, DBOS system schema), each of which SHALL have a MySQL counterpart.
- [ ] **Concurrency:** WHEN two schedulers race for the lease, or concurrent dispatches target the same budget group, agent row or OAuth client capacity, the MySQL implementation SHALL preserve the same invariants as Postgres (one leader; no budget overspend; no duplicate dispatch; capacity not exceeded).
- [ ] **Serialization retry:** WHEN MySQL reports a deadlock (errno 1213) or lock wait timeout (errno 1205) inside a retryable transaction, dispatch SHALL retry as it does for Postgres `40001`/`40P01`, up to `PERSIST_ATTEMPTS`.
- [ ] **Event bus:** WHEN a run changes status on MySQL, subscribers of `/admin/api/events` SHALL receive the same event kinds and payload shapes as on Postgres within 2 s at default settings, and a `resync` event after any poll outage.
- [ ] **DBOS rule:** WHEN `EXECUTOR=dbos` and the core database is MySQL, startup SHALL require `DBOS_SYSTEM_DATABASE_URL` to be a `postgresql://` URL and fail with an explanatory error otherwise.
- [ ] **Operator docs:** WHEN an operator follows `docs/` and `help/`, they SHALL find how to select MySQL, its version and privilege requirements, the behaviour differences, and the DBOS rule; `search_help` SHALL return the MySQL article for the queries "mysql" and "database".
- [ ] **Testing:** WHEN new code is added, the existing coverage thresholds in the vitest config SHALL still pass.
- [ ] **No regression:** WHEN `npm run typecheck`, `npm test` and `npm run build` run on Postgres, all SHALL pass.

---

## Data Model

> Source of truth for the Postgres schema remains `prisma/migrations/`. The MySQL schema is `prisma/mysql/schema.prisma` and its chain is `prisma/mysql/migrations/`. The two must never drift from their own migrations (CLAUDE.md).

### Layout (Decision 2)

```
prisma/schema.prisma            # PostgreSQL (unchanged, same path)
prisma/migrations/              # PostgreSQL, 66 migrations + lock (unchanged)
prisma/mysql/schema.prisma      # new
prisma/mysql/migrations/        # new: one baseline + future additive migrations
src/generated/prisma            # Postgres client (unchanged)
src/generated/prisma-mysql      # new MySQL client
```

### Mapping of Postgres constructs to MySQL 8.4

| Postgres construct (where) | MySQL schema/SQL |
|---|---|
| `Decimal(p,s)` | same `DECIMAL(p,s)` |
| `Json` (jsonb) | `JSON` |
| `String[]` ×12 (Run.grantedParentMemoryKeys, AuthUser.roles, AgentRepository.triggers, 8× AgentIssueProject, ModelCatalogEntry.efforts) | `Json` holding an array (Decision 6) |
| 10 enums (`CREATE TYPE … AS ENUM`) | native MySQL `ENUM` via Prisma `enum` |
| `AgentMemory.contentTsv tsvector` + GIN | no column; `FULLTEXT` index on `content` (`@@fulltext([content])`) |
| `DatastoreEntry_scope_xor`, `ResourceGrant_grantee_shape` CHECK | MySQL 8.4 `CHECK` (enforced), same expression |
| `CHECK (provider IN (…))`, `CHECK (protocol IN (…))` | same |
| `gen_random_uuid()` in data steps | n/a on empty DB (baseline only) |
| trigger `wardby_viewer_notify()` + `pg_notify` | six MySQL triggers inserting into `ViewerEvent` outbox |
| text/varchar identity | `VARCHAR(191)` for indexed strings, `utf8mb4` + `utf8mb4_0900_bin` (case-sensitive like Postgres) declared per table in migration SQL |
| `timestamp` | `DATETIME(3)`, session time zone forced to `+00:00` |

### New tables (MySQL only)

**`AdvisoryLock`** — transaction-scoped named locks (Decision 5)

| Column | Type | Nullable | Description |
|---|---|---|---|
| `key` | VARCHAR(191) | No | PK; lock name, e.g. `budget-group-dispatch`, `oauth-client-capacity`, `coding-slots`, `issue-dedupe:<hash>` |

Rows are created on demand with `INSERT IGNORE` then locked with `SELECT … FOR UPDATE`.

**`ViewerEvent`** — event-bus outbox (Decision 7)

| Column | Type | Nullable | Description |
|---|---|---|---|
| `id` | BIGINT AUTO_INCREMENT | No | PK; poll cursor |
| `payload` | JSON | No | same shape as the Postgres NOTIFY payload |
| `createdAt` | DATETIME(3) | No | default `CURRENT_TIMESTAMP(3)`; used for pruning |

**Indexes:** PK on `id`; index on `createdAt` (prune).

### Baseline migration

The MySQL chain starts with a single baseline migration that creates the **current** schema state. There is no legacy MySQL deployment, so the 66 Postgres steps are not replayed. Data written by Postgres migrations that matters on an empty database: the built-in `CodingService` seed rows from `20260927050000_coding_run_services` (the `20260927010000_resource_grants` statements are backfills and are no-ops on an empty database). The baseline includes the seeds.

---

## Dependencies

### External / packages
- `@prisma/adapter-mariadb` (same Prisma 7.10.0 line) for MySQL; `mysql2` is not required by it. Open-source dependency, no purchase, so no procurement ticket; adding it follows the normal dependency review.
- Docker image `mysql:8.4` for local compose/CI; Cloud SQL for MySQL 8.4 for GCP.
- DBOS stays on Postgres (`@dbos-inc/dbos-sdk` 4.27.6 depends on `pg`; it has no MySQL system database).

### Environment variables

| Variable | Purpose | Source |
|---|---|---|
| `DATABASE_URL` | scheme selects dialect (`postgresql://`, `postgres://`, `mysql://`) | operator secret |
| `SHADOW_DATABASE_URL` | drift check shadow DB (either dialect) | developer |
| `MIGRATION_DATABASE_URL` | privileged migrator URL (either dialect) | operator secret |
| `DBOS_SYSTEM_DATABASE_URL` | required Postgres URL for `EXECUTOR=dbos` when core is MySQL | operator secret |
| `WARDBY_MYSQL_*`, `WARDBY_MYSQL_PORT` (default 55306) | local compose/quickstart | `.env.local` |
| `VIEWER_POLL_INTERVAL_MS` (default 1000) | MySQL event-bus poll interval | operator config |

### MySQL server requirements (to be documented for operators)
- 8.4+, `utf8mb4`, InnoDB.
- Migration role needs `CREATE`, `ALTER`, `DROP`, `INDEX`, `REFERENCES` and `TRIGGER`; the app role needs only `SELECT`, `INSERT`, `UPDATE`, `DELETE` (no `LOCK TABLES`).
- With binary logging on, creating triggers requires `log_bin_trust_function_creators=1` (or `SUPER`); Cloud SQL exposes it as a database flag. Startup/doctor checks report a missing trigger or outbox table clearly.
- `caching_sha2_password` is the default auth plugin; the driver must support it (validated in Phase 0).

### Existing components to reuse

| Component | Location | How reused |
|---|---|---|
| `createPrismaClient`, `poolSettings` | `src/core/db.ts:27-87` | extended to pick adapter by scheme; pool params reused |
| `ViewerEventBus` interface | `src/viewer/event-bus.ts:30-42` | unchanged; second implementation |
| `isSerializationConflict`, `isLockTimeout`, `uniqueFields` | `src/core/dispatch.ts:170-189`, `src/core/issue-dedupe.ts:294-305`, `src/mcp/errors.ts:54-68` | become dialect-delegating |
| `prisma-adapter.database.test.ts` | `src/core/` | parameterized by dialect to pin MySQL error shapes |
| provider seams | `.okf/architecture/provider-seams.md` | `Dialect` follows the same pattern |

---

## Boundaries

**ALWAYS**
- Keep every Postgres code path byte-for-byte behaviourally identical; run the Postgres suite after each phase.
- Hand-write MySQL migration SQL from the schema (CLEANROOM rule 2); use `prisma migrate diff` only as the drift check, never as the source of SQL.
- Pair every schema change with both migrations from Phase 2 onward, and run both drift checks.
- Use the exact error text and codes in the Acceptance Criteria so tests and docs agree.

**ASK FIRST**
- Editing `CLAUDE.md` (Phase 2 and 6 add the MySQL drift-check procedure and the two-migration rule).
- Any change to a Postgres migration file, a Postgres table, or a Postgres error-code branch.
- Adding a runtime dependency beyond `@prisma/adapter-mariadb`.

**NEVER**
- Edit or reorder an applied Postgres migration; use `prisma db push`.
- Commit real credentials, `*.tfvars`, project ids or live-test output (CLAUDE.md Deployment rules).
- Write test-run narratives or our infrastructure details into `docs/`, `help/`, README or `deploy/**/*.md`.

---

## Design Decisions

### Decision 1: Dialect selection
| Approach | Pros | Cons |
|---|---|---|
| **Infer from `DATABASE_URL` scheme** | no new variable, cannot disagree with URL | scheme must be validated |
| `DATABASE_PROVIDER` variable | explicit | can mismatch URL; more to document |

**Decision:** infer from the scheme; `postgres://` and `postgresql://` map to Postgres, `mysql://` (and `mariadb://` as an alias accepted by the adapter, still version-guarded to MySQL 8.4+) to MySQL. A single `getDialect(url)` is the only place that parses it.

### Decision 2: Layout — keep Postgres in place
| Approach | Pros | Cons |
|---|---|---|
| **Postgres untouched, `prisma/mysql/` added** | zero churn to paths, checksums, package `files`, Dockerfile, docs | asymmetric layout |
| Move Postgres under `prisma/postgres/` | symmetric | touches every path reference; risks checksum/packaging mistakes |

**Decision:** leave Postgres where it is. `prisma.config.ts` and `prisma/migrate.config.mjs` choose `prisma/mysql/{schema.prisma,migrations}` when the URL scheme is `mysql://`.

### Decision 3: Two generated clients, typed against one
**Decision:** generate `src/generated/prisma` (Postgres, unchanged) and `src/generated/prisma-mysql`. Application code keeps importing `#prisma` types (Postgres client is the type source of truth). `core/db.ts` loads the MySQL client dynamically and returns it as the same `PrismaClient` type through a normalizing `$extends` (Decision 6). `build`/`prepare` run `prisma generate` for both configs; the Dockerfile check requires both client outputs and `@prisma/adapter-mariadb`.

### Decision 4: `Dialect` seam for divergent SQL only
**Decision:** `src/core/db/dialect.ts` defines the interface; `dialect-postgres.ts` holds today's SQL moved verbatim; `dialect-mysql.ts` is new. Statements that are portable through Prisma's model API or tagged-template SQL stay where they are. Quoting is made portable by setting `ANSI_QUOTES` in the MySQL session (`initSql`), so identifier-quoted SQL such as `"Run"."id"` is shared where syntax is otherwise standard; positional `$1` `$queryRawUnsafe` calls move into the dialect (`?` on MySQL). Interface surface (final list):

- `tryAcquireLease`, `lockBudgetGroupDispatch(tx)`, `lockAgentRowSkipLocked(tx, agentId)`, `lockUserRow(tx, id)`, `lockNamedRow(tx, table, id)`, `advisoryXactLock(tx, key)`, `setLockTimeout(tx, ms)`, `beginReadOnlyWithTimeout(tx, ms)`.
- `spendLine`, `treeCodingRuns`, cost-report aggregates, `memorySet`, `memorySearch`, `datastoreGet/List` size-guards, `secretCiphertext`, `rateLimitHit`, ledger statements (`reserve`, `complete`), grants migration report catalog probes.
- Error classifiers: `isSerializationConflict`, `isLockTimeout`, `uniqueViolationFields`.
- `createEventBus(connectionString)`, `checkServer(db)` (version + privileges + trigger/outbox presence), `listFilter(field, value)` for scalar-list membership.

### Decision 5: Transaction-scoped locks on MySQL via lock rows
| Approach | Pros | Cons |
|---|---|---|
| **`AdvisoryLock` row + `SELECT … FOR UPDATE`** | released at commit/rollback like `pg_advisory_xact_lock`; works through pooled interactive transactions | one extra table; must pre-insert row |
| `GET_LOCK()` | no table | session-scoped, survives commit, needs pinned connection and explicit release; leaks on error paths |
| `LOCK TABLES` | closest to Postgres table lock | implicitly commits the open transaction; unusable |

**Decision:** lock rows. Mapping: `LOCK TABLE "BudgetGroup" … SHARE ROW EXCLUSIVE` → key `budget-group-dispatch`; `pg_advisory_xact_lock(7412901)` → `oauth-client-capacity`; `7412902` → `coding-slots`; issue-dedupe bigint key → `issue-dedupe:<sha256 hex>`. The lock must be the first statement of its transaction where Postgres required it (dispatch), so waiters take their snapshot after the previous holder commits. `lock_timeout` equivalent: `SET SESSION innodb_lock_wait_timeout` scoped by `SET LOCAL`-style restore in a `finally` (MySQL has no `SET LOCAL`; the dialect restores the previous value on the same connection).

### Decision 6: `String[]` as `Json` with a normalizing extension
**Decision:** the MySQL schema declares the 12 list fields as `Json`. The MySQL client is wrapped with `$extends` (query extension) so reads return `string[]` and writes accept `string[]`, matching the Postgres types at runtime and, via a typed cast in `db.ts`, at compile time. The one place that filters a list (`src/core/review-fix.ts:120`, `triggers: { has: "review_fix" }`) goes through `dialect.listFilter` (`array_contains` on MySQL). Phase 0 confirms the extension approach and Json defaults; the fallback if Prisma cannot emit a JSON expression default on MySQL is hand-written `DEFAULT (JSON_ARRAY())` in migration SQL with the default also applied in the extension's `create` path, and the drift check run against the result.

### Decision 7: MySQL event bus = outbox + polling
**Decision:** triggers insert into `ViewerEvent` with the same suppression and payload logic as `wardby_viewer_notify()`. The MySQL bus polls `WHERE id > :cursor ORDER BY id LIMIT 500` every `VIEWER_POLL_INTERVAL_MS` (default 1000), starts from `MAX(id)` at first subscription, and emits `status`/`resync` exactly as the Postgres bus does (`onState(true)` after the first successful poll and after recovery from any failed poll). Any replica prunes rows older than 10 minutes once per minute (idempotent `DELETE … WHERE createdAt < …`). Trigger bodies must never fail the write: MySQL triggers use a `DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN END` around the insert.

### Decision 8: Memory search
**Decision:** MySQL uses InnoDB `FULLTEXT` on `AgentMemory.content` with `MATCH … AGAINST (? IN NATURAL LANGUAGE MODE)` and returns the relevance score as `rank`. Documented differences: no English stemming, stopword list and `innodb_ft_min_token_size` apply. Result ordering/shape (`key`, `content`, `rank`) is unchanged; tests assert the contract, not exact scores.

### Decision 9: DBOS on MySQL
**Decision:** `loadDbosConfig` rejects `EXECUTOR=dbos` with a MySQL core unless `DBOS_SYSTEM_DATABASE_URL` is a Postgres URL. No other code changes. `dbos:migrate` uses that URL. Documented as the single Postgres exception.

### Decision 10: Both drift checks
**Decision:** add `npm run db:drift` that runs the Postgres check (existing CLAUDE.md procedure) and `db:drift:mysql` (new shadow `wardby_shadow` on the local MySQL container). CLAUDE.md gets the MySQL procedure and the rule "every schema change ships both migrations" (ASK FIRST item).

---

## Phase Summary

| Phase | Name | Goal | Plan | Status |
|---|---|---|---|---|
| 0 | Feasibility spike | Prove the adapter, auth plugin, ANSI_QUOTES init, Json arrays/defaults, extension typing and `dbos` guard assumptions before committing | `.claude/thoughts/plans/2026-10-09-mysql-phase-0-feasibility-spike.md` | Not Started |
| 1 | Dialect seam | Move divergent SQL/locks/error classifiers behind `Dialect` with only the Postgres implementation; no behaviour change | `.claude/thoughts/plans/2026-10-09-mysql-phase-1-dialect-seam.md` | Not Started |
| 2 | MySQL schema and migrations | `prisma/mysql/` schema + baseline migration, both drift checks, generated clients, config selection | `.claude/thoughts/plans/2026-10-09-mysql-phase-2-schema-and-migrations.md` | Not Started |
| 3 | MySQL dialect and event bus | Implement locks, upserts, search, ledger, errors, version guard, outbox bus | `.claude/thoughts/plans/2026-10-09-mysql-phase-3-mysql-dialect.md` | Not Started |
| 4 | Config, deploy, quickstart | Scheme selection everywhere, local compose, quickstart, GCP Cloud SQL, production compose, DBOS guard | `.claude/thoughts/plans/2026-10-09-mysql-phase-4-config-deploy-quickstart.md` | Not Started |
| 5 | Tests and CI matrix | Dialect-aware test helpers, MySQL variants, CI service containers, both drift checks in CI | `.claude/thoughts/plans/2026-10-09-mysql-phase-5-tests-and-ci.md` | Not Started |
| 6 | Docs and help | Operator docs, help articles, error articles, README, OKF, CLAUDE.md | `.claude/thoughts/plans/2026-10-09-mysql-phase-6-docs-and-help.md` | Not Started |

**Ordering rationale:** the spike de-risks assumptions cheaply; the seam (1) lands first because it is a pure refactor verifiable on Postgres alone; the schema (2) is needed before a MySQL dialect (3) can be exercised; deploy (4) and CI (5) need a working core; docs (6) describe the final behaviour. Phases 1 and 2 touch disjoint files and may run in parallel after Phase 0.

---

## Monitoring

No new metrics. Add structured log fields only:
- startup: `database.dialect` and, for MySQL, `database.version`;
- MySQL event bus: poll failure/recovery warnings (throttled like the Postgres bus), cursor lag when `now - createdAt` of the newest unseen event exceeds 10 s;
- doctor/quickstart `doctor` reports dialect, version, trigger privilege and outbox presence.

---

## Error Handling Matrix

| Scenario | Detection | Response | User Impact |
|---|---|---|---|
| Unsupported URL scheme | `getDialect` | fail startup naming supported schemes | clear config error |
| MySQL < 8.4 | `SELECT VERSION()` in `checkServer` | fail startup with minimum version | clear config error |
| Trigger creation blocked by binlog setting | migration error `ER_BINLOG_CREATE_ROUTINE_NEED_SUPER` (1419) | migration fails; docs and `help/errors` article describe flag | operator sets flag, reruns |
| Deadlock / lock wait timeout in dispatch | errno 1213 / 1205 through adapter | retry up to 8 times with existing jittered backoff; then 409 "retry" | transient 409 under heavy contention |
| Poll query fails (event bus) | caught in poll loop | `onState(false)`, throttled warn, retry on interval; `resync` on recovery | live indicator off, then resync |
| Outbox table missing | `checkServer` at startup/doctor | fail startup | clear migration-needed error |
| `EXECUTOR=dbos` on MySQL without Postgres URL | config load | fail startup (Decision 9) | clear config error |
| Unique violation on MySQL | errno 1062 via adapter → P2002 | same 409 messages via `uniqueViolationFields` | same as Postgres |

---

## Resolved Questions

1. **~~Which MySQL versions?~~** — 8.4+ only (user, 2026-10-09). MariaDB out.
2. **~~Is MySQL a configurable alternative or a replacement?~~** — configurable alongside Postgres (user).
3. **~~Event bus on MySQL?~~** — outbox table + polling (user).
4. **~~DBOS on MySQL?~~** — separate Postgres via `DBOS_SYSTEM_DATABASE_URL` (user chose this after verification that the DBOS SDK depends on `pg` and documents a Postgres-compatible system database only).
5. **~~Jira ticket?~~** — none yet; create DEVXP story at ship time.
6. **~~Layout?~~** — Decision 2 (Postgres in place).
7. **~~Scalar lists?~~** — Decision 6 (Json + extension; Postgres untouched).
8. **~~Replay 66 migrations on MySQL?~~** — no; single baseline (Data Model).

## Open Questions

None. Phase 0 exists to *verify* assumptions already decided (adapter behaviour, JSON defaults); each has a stated fallback in the decision above, so no phase is blocked on an open question.

---

## Definition of Done

### Automated Verification

```bash
npm run typecheck
npm run lint
npm run format:check
npm test                                  # Postgres, DATABASE_URL=postgresql://…
DATABASE_URL=mysql://… npm test           # MySQL 8.4
npm run test:phase5:database              # both DBs
npm run db:drift && npm run db:drift:mysql
npm run build && npm run test:production-boundary
```

### Acceptance Criteria Verification
Every item in [Acceptance Criteria](#acceptance-criteria) verified.

### Integration Verification
- [ ] Quickstart on MySQL: start, migrate, create agent, run, see the live event in the viewer.
- [ ] Two server replicas on MySQL: one lease holder; viewer events reach both.
- [ ] Postgres quickstart and GKE overlay unaffected.
- [ ] `EXECUTOR=dbos` on MySQL core with a Postgres system URL completes a run.

---

## Change Log

### v1.0.0 (2026-10-09)
**Changes:** initial spec from the database-coupling investigation and user decisions (MySQL 8.4+, URL-scheme selection, outbox bus, separate Postgres for DBOS).
**Author:** Claude (Sonnet 5.5) for fbrodrigorezino
