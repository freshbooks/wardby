---
date: 2026-10-09T17:32:22+0000
researcher: Claude (Sonnet 5.5) for fbrodrigorezino
git_commit: 5f68c9efc8736c4238d3d38398cf63637ebd43f4
branch: add-support-for-mysql
repository: wardby
topic: "How wardby's database layer works today and where it depends on PostgreSQL"
tags: [research, codebase, database, postgresql, prisma, migrations, raw-sql, event-bus, locking, deploy]
status: complete
last_updated: 2026-10-09
last_updated_by: Claude (Sonnet 5.5)
---

# Research: Database layer and PostgreSQL coupling

**Date**: 2026-10-09T17:32:22+0000
**Researcher**: Claude (Sonnet 5.5)
**Git Commit**: 5f68c9efc8736c4238d3d38398cf63637ebd43f4
**Branch**: add-support-for-mysql
**Repository**: wardby

## Research Question

The user's message was "start" with no explicit query. Interpreted charitably from the session context (the user wants MySQL, 8.4+, as a configurable core database): document how wardby's database layer works today and where each part depends on PostgreSQL.

## Summary

wardby's own persistence is PostgreSQL accessed through Prisma 7 with the `@prisma/adapter-pg` driver adapter. The Prisma schema (54 models, 10 enums) and its migration chain (66 migrations) are Postgres-only. 19 non-test source files issue raw SQL, much of it using Postgres-specific syntax and locking. A raw `pg.Client` runs `LISTEN` for the viewer event bus, fed by plpgsql triggers created in migrations. An optional DBOS executor keeps its own state in a separate `dbos` schema in the same Postgres. Deployment, CI, docs, help articles and 30+ test files all assume Postgres. MySQL appears only as an optional per-run service for coding runs.

## Detailed Findings

### 1. Schema and Prisma configuration

- Generator: `prisma/schema.prisma:9-14` — `provider = "prisma-client"`, `output = "../src/generated/prisma"`, ESM, nodejs runtime (no native engine).
- Datasource: `prisma/schema.prisma:18-20` — `provider = "postgresql"`, no `url` in the schema. `prisma/migrations/migration_lock.toml:3` — `provider = "postgresql"`.
- `prisma.config.ts:23-30`: `schema: "prisma/schema.prisma"`, `migrations.path: "prisma/migrations"`, `datasource.url = process.env.DATABASE_URL ?? ""` (so `generate`/`validate` work without a DB), `shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL`. Loads dotenv-flow from `<projectDir>/.wardby` then `<projectDir>` (`:19-21`).
- `prisma/migrate.config.mjs`: import-free config shipped in the npm package (`package.json:43`), used by `wardby quickstart`/`doctor` via `src/quickstart/migrate.ts` to run `npx prisma@<version> migrate deploy|status`.
- 54 models (1,427-line schema) and 10 enums: `AgentKind` (:132), `RunStatus` (:137), `RunTrigger` (:306), `CodingServiceState` (:544), `CodingProxySessionStatus` (:575), `CodingProxyRequestStatus` (:580), `RegistryFetchOutcome` (:651), `TaskKind` (:810), `TaskStatus` (:815), `WebhookStatus` (:886).
- Model groups: core (Agent, AgentSubAgent, BudgetGroup, Run, RunModelUsage, ModelCatalogEntry, SchedulerLease, Task); tools/datastores/secrets; coding (CodingRun, CodingProxySession/Request, …); package registry; identity/auth/OAuth/grants; code-review host; issue tracker.
- Postgres-specific constructs in the schema:
  - `@db.Decimal` only native type: `Decimal(10,4)` (Agent.budgetUsd :27, BudgetGroup caps :121-123), `Decimal(3,2)` (:124), `Decimal(10,6)` (Run.costUsd :322, CodingRun.budgetReservedUsd :462), `Decimal(18,10)` (:598, :633-634, :1400).
  - `AgentMemory.contentTsv Unsupported("tsvector")?` (:298) with `@@index([contentTsv], type: Gin)` (:302); maintained by application code, not a generated column (:290-293).
  - `String[]` scalar lists (12 fields): `Run.grantedParentMemoryKeys` (:371), `AuthUser.roles` (:946), `AgentRepository.triggers` (:1072), eight on `AgentIssueProject` (:1248-1270), `ModelCatalogEntry.efforts` (:1419). All but `efforts` default to `[]`.
  - `Json` fields used widely (stored as `jsonb`; no `@db.JsonB`): Tool.jsonSchema, AgentTool allowed* fields, DatastoreEntry.value, Run.pricingSnapshot, CodingRun/CodingAgentProfile/CodingService config columns, CodingProxySession/Request, RegistryVersionFact.dependencies, Task, SecretElicitationOutcome, OAuthClient.metadata.
  - Defaults are only `cuid()`, `now()`, `@updatedAt`, literals and `[]`; no `dbgenerated`, `uuid()`, `autoincrement()`.
  - Constraints that exist only in migration SQL and are named in schema comments: `DatastoreEntry_scope_xor` (:249-253), `ResourceGrant_grantee_shape` (:786-788).
- Scripts (`package.json`): `prisma:generate` (:69), `prisma:migrate` = `prisma migrate deploy` (:70), `dbos:migrate` (:71), `db:up`/`db:down` (:72-73), `build`/`prepare` run `prisma generate` (:59-60). No npm script exists for the drift check; it is documented only in `CLAUDE.md`.
- Generated client: `src/generated/prisma` (git-ignored, `.gitignore:47-48`), imported through the `#prisma` import map (`package.json:22-27`: `wardby-source` → `src/generated/prisma/client.ts`, default → `dist/generated/prisma/client.js`).
- Versions: `@prisma/client`, `@prisma/adapter-pg`, `prisma` 7.10.0 (`package.json:101-102,138`); `pg` (:114).

### 2. Migrations (66 directories, `20260905000000_init` … `20261008000000_review_after_ci`)

Postgres-only SQL by category:
- **Enums**: `CREATE TYPE … AS ENUM` and `ALTER TYPE … ADD VALUE` (init, scheduler_durability, tools_multiturn, phase5_coding_agents, coding_proxy_ledger, run_trigger_webhook, agent_sub_agent, run_trigger_host_event, mcp_phase4, coding_package_registry, coding_run_service_status). `20260912010000_coding_provider_contract` converts an enum to text with `USING "provider"::TEXT`, drops the type, adds `CHECK` constraints.
- **CHECK constraints**: `coding_proxy_protocol`; `named_shared_datastores` (`DatastoreEntry` XOR check :50-51); `resource_grants` (`ResourceGrant_grantee_shape` :37-41).
- **tsvector/GIN**: `20260912030000_agent_memory` (`"contentTsv" tsvector` :12, `USING GIN` :18).
- **`gen_random_uuid()`**: `named_shared_datastores` (:61), `resource_grants` (header notes PG 13+, :4).
- **Arrays**: `TEXT[] DEFAULT ARRAY[]::TEXT[]` in agent_sub_agent, code_review_hosts, auth_user_roles, jira_* migrations; `'pull_request' = ANY("triggers")` in repo_access_authorization (:79).
- **JSONB** columns and functions: many migrations; `tool_capability_scoping` uses `jsonb_agg`, `'[]'::jsonb`.
- **`UPDATE … FROM` backfills**: agent_secret_bound_name, resource_grants (:62-72).
- **plpgsql triggers**: `20261003020000_viewer_notify` creates `wardby_viewer_notify()` (:4-41) and six `AFTER INSERT OR UPDATE … FOR EACH ROW` triggers (:43-54); `20261003030000_viewer_notify_fixes` redefines it with `CREATE OR REPLACE`, adds an `EXCEPTION WHEN OTHERS` wrapper around `pg_notify` (:38-44).
- Not found by grep: `CREATE EXTENSION`, `ON CONFLICT`, partial/expression indexes, `CONCURRENTLY`. `20260925030000_tool_name_per_owner` has a comment that Postgres treats NULLs as distinct in unique indexes.
- Several early migrations wrap statements in `BEGIN`/`COMMIT`.

### 3. Connection and client

- `src/core/db.ts`:
  - `createPrismaClient(url = process.env.DATABASE_URL, options)` (:73-85) builds `new PrismaPg({connectionString, max, connectionTimeoutMillis})` → `new PrismaClient({adapter})`. Singleton `prisma` at :87.
  - Pool: `max` default `availableParallelism()*2+1` (:29-31), `connectionTimeoutMillis` 10,000 (:6-22 comment). URL params `connection_limit` and `pool_timeout` (seconds) override (:38-54). TLS taken from URL (`sslmode`, `sslrootcert`).
  - `MissingUrlAdapter extends PrismaPg` (:61-65) throws "DATABASE_URL is not set" on first `connect()`.
  - `options.poolMax` per-caller override; `src/coding-proxy/main.ts:23-24` creates two clients (ledger via `CODING_PROXY_DB_POOL_MAX`, default 5; registry).
- Raw `pg` outside Prisma: `src/viewer/event-bus.ts` (see §5), `scripts/npm-package-acceptance.mjs`, 5 test files.

### 4. Raw SQL by file (all via Prisma with the pg adapter; camelCase identifiers double-quoted)

| File | What it does | Postgres-specific features |
|---|---|---|
| `src/core/lease.ts:16-27` | Scheduler leader lease, single statement, no transaction | `INSERT … ON CONFLICT DO UPDATE … WHERE`, `EXCLUDED`, `RETURNING`, `now()` |
| `src/core/dispatch.ts:244,555-578` | Run creation transaction (Serializable) | `LOCK TABLE "BudgetGroup" IN SHARE ROW EXCLUSIVE MODE`; `SELECT … FOR UPDATE SKIP LOCKED` |
| `src/core/issue-dedupe.ts:114-117,168-172` | Issue-filing dedupe lock | `set_config('lock_timeout', …, true)`, `pg_advisory_xact_lock(bigint)` from SHA-256 |
| `src/core/cost-report.ts:207-260` | Cost report (RepeatableRead, read-only) | `SET TRANSACTION READ ONLY`, `SET LOCAL statement_timeout`, `COUNT(DISTINCT) FILTER (WHERE …)`, `SUM(…) FILTER`, `NULLS LAST`, `::text`, `Prisma.sql`/`Prisma.join` |
| `src/core/issue-status.ts:53-87` | Spend roll-up over run tree | `WITH RECURSIVE … UNION`, `::text` |
| `src/core/related-pull-requests.ts:69-87` | Coding-run tree walk | `WITH RECURSIVE up/down` |
| `src/core/secrets.ts:111-122` | Size-bounded secret read | `octet_length()` |
| `src/providers/memory/postgres.ts:53-81` | Agent memory set/search | `to_tsvector`, `plainto_tsquery`, `@@`, `ts_rank … ::float8`, `ON CONFLICT`, `INSERT … SELECT … WHERE (SELECT count(*)…)` |
| `src/providers/datastore/postgres.ts:31-127` | Datastore get/list | `octet_length("value"::text)`, `starts_with()` |
| `src/providers/coding-proxy/prisma-ledger.ts:136-377` | Budget ledger | `FOR UPDATE`, `::jsonb`, `::integer`, `UPDATE … FROM (subquery) … RETURNING`, `SAVEPOINT`/`ROLLBACK TO`/`RELEASE`, `ON CONFLICT`, `COALESCE(SUM(CASE …))` |
| `src/providers/auth/self-hosted.ts:136-137,299,357` | OAuth capacity + rotation | `pg_advisory_xact_lock(7412901)`, `FOR UPDATE` with `$1` positional params |
| `src/mcp/auth/self-hosted/credentials.ts:42,85,109,138` | AuthUser row locks | `FOR UPDATE` |
| `src/mcp/auth/self-hosted/rate-limit.ts:12-20` | Rate limiter | `ON CONFLICT … DO UPDATE SET hits = hits + 1 RETURNING hits` |
| `src/mcp/auth/grants-cli.ts:124-270` | Grants migration report (read-only, runs against schemas the client may not match) | `to_regclass`, `information_schema.columns`, `current_schema()`, `IS DISTINCT FROM`, `\|\|`, `UNION ALL` |
| `src/providers/executor/container.ts:65,280-311` | Coding slot lock | `pg_advisory_xact_lock(7412902)` |
| `src/quickstart/index.ts:476-489` | Health check | `SELECT 1` |

`runner.ts`, `host-events.ts`, `reconciler.ts` contain no raw SQL (only `$queryRaw`/`$transaction` in `Pick<PrismaClient,…>` types). Not present anywhere: `ILIKE`, array operators in `src/`, jsonb operators (`->`, `->>`, `@>`), `generate_series`, `date_trunc`.

### 5. Viewer event bus (LISTEN/NOTIFY)

- Single channel `wardby_viewer` (`src/viewer/event-bus.ts:21`, `VIEWER_CHANNEL`).
- Publishers are database triggers only (migrations in §2); no application code calls `pg_notify`. Payload kinds: `run`, `service`, `outcome` (sources `pull_request`, `host_status`, `issue_status`, `host_check`). `Run` updates that change none of status/turns/costUsd/tokens/finishedAt/parentRunId are suppressed (heartbeat-only).
- `createViewerEventBus` (`event-bus.ts:44-253`): raw `pg.Client` (`keepAlive`, 30 s initial delay), lazy open on first subscriber, `LISTEN wardby_viewer` (:199-201), `SELECT 1` health check every 60 s with 10 s timeout (:140-164), reconnect backoff `[500, 1000, 2000, 5000, 10000]` ms (:166-175), bounded `end()` of 2 s, JSON + `ViewerEventSchema` validation with throttled warnings.
- Wiring: `src/mcp/index.ts:392-405` creates it only when `DATABASE_URL` is set; one LISTEN connection per server replica.
- SSE consumer `src/viewer/http.ts:51-105`: `GET /admin/api/events` (scope `admin:view`), `hello`/`status`/`resync` events, 15 s `: ping`, 1 MiB backpressure cutoff, `retry: 3000`.
- Operator doc: `docs/viewer-api.md:131`.

### 6. Error interpretation

- `src/mcp/errors.ts:94-117` `mapPrismaError`: serialization conflict → 409; `P2002` → 409 with humanized model/field names; `P2003` → 409; others → 500 with a reference UUID (`internalDatabaseError` :130-134). `uniqueFields` (:54-68) reads `meta.target`, `meta.driverAdapterError.cause.constraint.fields`, or parses the index name `<Model>_<field>_key`.
- `src/core/dispatch.ts:150,170-189` `isSerializationConflict`: `P2034`; `P2002` only for model `WorkItem`; `P2010` with `cause.originalCode` `40001`/`40P01`; `DriverAdapterError` with those codes (COMMIT-time shape). `PERSIST_ATTEMPTS = 8` (:274), backoff ceiling `min(250, 20·2^attempt)` (:275-281).
- `src/core/issue-dedupe.ts:294-305` `isLockTimeout`: SQLSTATE `55P03`.
- Other branches on codes: `P2002` in `host-events/github-ingress.ts:74`, `jira-ingress.ts:87`, `import/create.ts:285,331,365`, `core/host-identity-links.ts:213`; `P2003` in `core/tool-admin.ts:146`, `mcp/tools/agents.ts:788`, `datastore.ts:102` (also P2014). `P2025` unused in non-test code.
- `src/core/prisma-adapter.database.test.ts` pins which Prisma codes arrive through `@prisma/adapter-pg` (retry behaviour, P2002/P2003/P2010/P2014/P2034 mapping, friendly messages).

### 7. Transactions and locking

- Scheduler: `tryAcquireLease` (`lease.ts:16-27`), called only from `scheduler.ts:118` (`leaseTick`); timing `TICK_INTERVAL_MS` 10 s, `LEASE_TTL_MS` 30 s, `LEASE_RENEW_INTERVAL_MS` 10 s (`timing.ts:3-5`). `tick()` returns early when not leader (`scheduler.ts:127-130`).
- `dispatchRun` (`dispatch.ts:539`): preview read outside the transaction, then `$transaction(…, {isolationLevel: "Serializable"})` (:569-776); coding agents with a budget group take the table lock first (:572); `claimDueRun` (`scheduler.ts:55-84`) passes `lockAgent: true` for `FOR UPDATE SKIP LOCKED` (:573-578).
- Serializable elsewhere: `core/tool-admin.ts:115,141`, `core/host-identity-links.ts:209`, `mcp/tools/{tools:391, agents:707/979, scheduling:40, repositories:203, grants:97}`, `mcp/auth/grants-cli.ts:521,622`. RepeatableRead: `cost-report.ts:214`. Default isolation: `core/coding-queue.ts:58`, `cli.ts:217`, `executor/container.ts:282,361,394,429`, self-hosted auth transactions.
- Row locks, advisory locks and table lock sites are listed in §4.

### 8. DBOS executor (optional)

- `EXECUTOR=dbos` uses `@dbos-inc/dbos-sdk` 4.27.6 (`package.json:96`). `src/providers/executor/dbos.ts:112-113` requires `DBOS_SYSTEM_DATABASE_URL` or `DATABASE_URL`; `DBOS.setConfig({… systemDatabaseUrl …})` (:141-143), `DBOS.launch()` (:149).
- Its tables live in a separate `dbos` schema outside Prisma's migration chain, created at `launch()` or by `npm run dbos:migrate` (`dbos schema "$DATABASE_URL"`, `package.json:71`). Documented at `docs/security-deployment.md:438-489`.
- Config: `loadDbosConfig` (`src/config/providers.ts:510-516`) — `systemDatabaseUrl = DBOS_SYSTEM_DATABASE_URL ?? DATABASE_URL`, `schemaName = DBOS_SCHEMA ?? "dbos"`, `executorId = DBOS_EXECUTOR_ID ?? randomUUID()`. `DBOS.setConfig({name:"wardby", systemDatabaseUrl, systemDatabaseSchemaName, executorID, runAdminServer:false})` (`dbos.ts:141-148`). wardby does not name a driver for DBOS; the SDK connects to the URL itself, and `node_modules/@dbos-inc/dbos-sdk` was not installed in this checkout, so its internal SQL/driver was not inspected.
- Stored state: one workflow per run (`wardby.run`, `workflowID: runId`, `dbos.ts:85-92,181`), steps via `DBOS.runStep` (`:70`); status values handled in `dbos-status.ts:58-59`. The executor's own application reads/writes (`run.updateMany` setting `executionBackend: "dbos"`, `run.findUnique`) still go through the Prisma client (`dbos.ts:109,169-172,225`).
- Privileges and migration: `deploy/gke/database-grants.sql:51-74` creates schema `dbos` and grants the app role USAGE, table DML, sequence and function rights plus default privileges; `deploy/gke/database-grants.database.test.mjs:364` checks tables `workflow_status`, `operation_outputs`, `dbos_migrations`. The GKE migration job runs `npm run prisma:migrate && npm run dbos:migrate` (`deploy/kind-coding/manifests/overlays/gke-autopilot/migrate/job.yaml:80`).
- Tests: `src/providers/executor/dbos.database.test.ts:120,289` (uses `systemDatabaseUrl: process.env.DATABASE_URL`, `schemaName: "dbos_test"`).

### 9. Deployment, CI, docs and tests

- Local: `deploy/local/docker-compose.yml:2-19` runs `postgres:16-alpine` on `${WARDBY_POSTGRES_PORT:-55432}:5432` with `pg_isready` healthcheck; `docker-compose.phase5.yml` and `deploy/observability/docker-compose.grafana.yml` point `DATABASE_URL` at `postgres:5432`. Quickstart picks a port from 55432 to 55532 (`src/quickstart/index.ts:123-161`) and builds a `postgresql://` URL.
- Production compose (`deploy/production/compose.yml:3,99`) does not run Postgres; migration service reads `MIGRATION_DATABASE_URL`. Env example has `DATABASE_URL` (port 5432, `sslmode=verify-full`), `MIGRATION_DATABASE_URL`, `DBOS_SYSTEM_DATABASE_URL`. `scripts/production-boundary-policy.mjs:31` asserts the compose migration line.
- `deploy/Dockerfile:53,66` requires `dist/generated/prisma/client.js` and `node_modules/@prisma/adapter-pg`.
- GCP Terraform (`deploy/gcp`): `cloudsql.tf` (`POSTGRES_16`), `secrets.tf:14` (`postgresql://…?host=/cloudsql/…`), `cloud-run.tf:71`, `migration-job.tf:40`. `deploy/aws/` contains only `.gitkeep`.
- GKE (`deploy/gke`, `deploy/kind-coding`): Cloud SQL Postgres 16, Auth Proxy on 5432/3307, IAM URLs in `up.sh:69-83`, `bootstrap-grants-job.yaml` uses `postgres:16-alpine`, `database-grants.sql` tested by `database-grants.database.test.mjs`, NetworkPolicy egress to `host.docker.internal:55432` and Cloud SQL ports.
- CI: `.github/workflows/security.yml:28-94` and `publish-npm.yml:16-48` start Postgres 16 service containers and run `prisma:generate`/`prisma:migrate`. No azure CI directory, no helm chart, no `ci.yml`.
- Tests: 32 `*.database.test.ts` files gated by `describe.skipIf(!process.env.DATABASE_URL)`, plus about 11 other tests gated on `DATABASE_URL` (e.g. `core/lease.test.ts`, `core/scheduler.test.ts`, `memory/postgres.test.ts`, `datastore/postgres.test.ts`). Files importing `pg` directly: `core/repo-access.database.test.ts`, `core/grants-migration.database.test.ts`, `mcp/auth/grants-cli.database.test.ts`, `viewer/notify.database.test.ts`, `viewer/event-bus.database.test.ts`. No shared `pg` test helper; each test builds its own client or uses `createPrismaClient`.
- Operator docs mentioning Postgres: `README.md` (46, 54, 181, 255, 259, 352-357, 374), `docs/` (getting-started, getting-started-gke, coding-services, security-deployment incl. PostgreSQL 13+ at :195, architecture-runtime, viewer-api, release-verification, coding-worker-isolation, agent-recipes, coding-agent-setup), `help/` (deploy-gke, coding-services, deployment-targets, agent-recipes, troubleshooting/coding-workers, errors/service-*).
- MySQL today: `README.md:374` and `.okf/architecture/coding-workers.md:42` — per-run services (`src/coding/services`: Postgres, Redis, MySQL) declared by coding runs; unrelated to wardby's own storage.

## Code References

- `prisma/schema.prisma:18-20` — datasource provider `postgresql`
- `prisma/schema.prisma:298-302` — `tsvector` Unsupported column + GIN index
- `prisma.config.ts:23-30` — Prisma CLI config (schema, migrations, URL, shadow URL)
- `src/core/db.ts:73-87` — client + pg adapter construction, pool sizing
- `src/core/lease.ts:16-27` — scheduler lease upsert
- `src/core/dispatch.ts:244,539-789` — table lock, Serializable dispatch, retry loop
- `src/core/issue-dedupe.ts:165-172` — advisory lock + lock_timeout
- `src/providers/coding-proxy/prisma-ledger.ts:182-334` — reserve/complete with row locks and savepoint
- `src/providers/memory/postgres.ts:53-81` — full-text memory
- `src/viewer/event-bus.ts:44-253` — LISTEN/NOTIFY bus
- `prisma/migrations/20261003020000_viewer_notify/migration.sql:4-54` — notify function + triggers
- `src/mcp/errors.ts:94-117` — Prisma error → HTTP mapping
- `src/providers/executor/dbos.ts:112-149` — DBOS system database
- `deploy/local/docker-compose.yml:2-19` — local Postgres 16

## Architecture Documentation

- One database engine behind Prisma 7 with a driver adapter; all Prisma access goes through `src/core/db.ts`, and the client is imported via the `#prisma` alias.
- Schema is hand-written; migrations are the deployed source of truth and are replayed against an empty shadow DB for the drift check (documented in `CLAUDE.md`, `.okf/data/database-and-migrations.md`).
- Concurrency control relies on Postgres primitives: Serializable isolation with application-level retry, row locks (`FOR UPDATE`, `SKIP LOCKED`), table lock, transaction-scoped advisory locks (keys 7412901, 7412902, SHA-256-derived bigint), and single-statement upserts for the lease and rate limiter.
- Provider seams exist for memory and datastore (`src/providers/{memory,datastore}/postgres.ts`), coding-proxy ledger (`prisma-ledger.ts`) and executor (`dbos.ts`, `container.ts`); the file names for memory and datastore are Postgres-specific.
- Change notification is trigger-based (`pg_notify` inside plpgsql) with a dedicated raw `pg.Client` listener per server replica.
- Large reads/aggregations in `cost-report.ts`, `issue-status.ts`, `related-pull-requests.ts` use `Prisma.sql` fragments with recursive CTEs and `FILTER` aggregates.

## Historical Context (from thoughts/)

- `./.claude/thoughts/` was empty and `thoughts/` does not exist; no prior investigations on this topic.
- `.okf/data/database-and-migrations.md` — OKF rulebook for Postgres + Prisma migrations and the drift check (generated by claude-code/claude-sonnet-5-5, 2026-10-09T17:00:00Z; no `verified` entry).
- `.okf/architecture/provider-seams.md`, `runner-and-engine.md`, `coding-workers.md`, `coding-proxy.md`, `mcp-server.md` — related architecture concepts (one keyword hit each for database-adjacent terms).
- `docs/private/mysql-support-plan.md` — draft plan written earlier in this session (git-ignored); not derived from this document.

## Open Questions

- Migration count: `ls prisma/migrations` lists 67 entries including `migration_lock.toml`, i.e. 66 migration directories.
- Earlier in this session the scalar-list count was given as 21 from a rough grep; the schema-focused read found 12 `String[]` fields (this document uses 12). The 35 `Json` count from that grep was also rough.
- Not read in full: every migration body (Postgres-only inventory came from grep plus targeted reads); the remaining `Serializable` transaction sites beyond their line references; `src/mcp/host-events/jira-ingress.ts`, `src/import/create.ts`, `src/mcp/tools/agents.ts` and `datastore.ts` code-branching (grep-level only).
- `src/` hits for Postgres/`DATABASE_URL` outside the listed areas were capped at 120 lines in the locator pass, so `src/` coverage there is partial.
- The `src/coding/services` built-ins (Postgres/Redis/MySQL per-run services) were located but not analyzed.
- Whether `grants-cli.ts` and `src/quickstart/` have additional Postgres-specific behaviour beyond the lines cited was not traced.
