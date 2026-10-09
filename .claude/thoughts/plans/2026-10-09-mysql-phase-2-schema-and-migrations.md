# MySQL Phase 2: Schema and migrations

**Spec:** `.claude/thoughts/investigations/2026-10-09-mysql-core-database-spec.md`
**Jira:** none yet
**Depends on:** Phase 0 findings confirmed (A2, A3 decide default/quoting details). May run in parallel with Phase 1 (disjoint files).

---

## Overview

Create `prisma/mysql/schema.prisma` and a hand-written baseline migration that produces the current schema on MySQL 8.4, with config selection, client generation and a drift check that mirrors the Postgres one. Postgres files are not touched.

## Current State Analysis

- Postgres schema: 54 models, 10 enums (`prisma/schema.prisma`), 66 migrations, lock file `provider = "postgresql"` (`migration_lock.toml:3`).
- `prisma.config.ts:23-30` is single-schema; `prisma/migrate.config.mjs` likewise.
- Data written by migrations that matters on an empty DB: built-in `CodingService` rows (`20260927050000_coding_run_services/migration.sql:39+`).
- Postgres-only schema constructs to translate: investigation §1–§2 and the spec's mapping table.

### Key Discoveries
- Only `@db.Decimal` is used as a native type; no `dbgenerated`/`uuid()`/`autoincrement()` defaults, so the Prisma-level translation is small.
- Comment-documented CHECK constraints (`DatastoreEntry_scope_xor`, `ResourceGrant_grantee_shape`, `provider`/`protocol` checks) exist only in migration SQL and must be reproduced in the MySQL baseline.
- Schema is hand-written per CLEANROOM rule 2; SQL must be written by hand, `migrate diff` is the check only.

## Changes Required

- [ ] **MySQL schema** (`prisma/mysql/schema.prisma`)
  - Verify: `npx prisma validate --schema prisma/mysql/schema.prisma`
  - Files: `prisma/mysql/schema.prisma`
  ```prisma
  generator client {
    provider     = "prisma-client"
    output       = "../../src/generated/prisma-mysql"
    moduleFormat = "esm"
    runtime      = "nodejs"
  }
  datasource db { provider = "mysql" }
  ```
  Copy the 54 models and 10 enums, then change: `String[]` ×12 → `Json` (+ Phase 0 default decision); `AgentMemory.contentTsv` removed and `@@fulltext([content])` added; `@@index([contentTsv], type: Gin)` removed; indexed/ID strings `@db.VarChar(191)` where required for key length; add `AdvisoryLock` and `ViewerEvent` models. Keep relation names, `@@map`-free table names and field names identical so the generated TS model shapes match.

- [ ] **Baseline migration** (`prisma/mysql/migrations/20261009000000_baseline/migration.sql`, `prisma/mysql/migrations/migration_lock.toml`)
  - Verify: replay on empty MySQL 8.4 (see drift check below)
  - Files: those two
  Hand-write in dependency order: enum-bearing tables (native `ENUM`), `CREATE INDEX`/`UNIQUE` matching every `@@index`/`@@unique`, FKs (including the explicit `onDelete: Restrict` on `DatastoreEntry.datastore`), CHECK constraints with the same expressions as Postgres, `DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin` per table, `FULLTEXT KEY` on `AgentMemory.content`, the `CodingService` built-in seed rows (values copied from the Postgres migration’s resulting state), `AdvisoryLock`, `ViewerEvent` with `createdAt` index. `migration_lock.toml`: `provider = "mysql"`.

- [ ] **Outbox triggers** (`prisma/mysql/migrations/20261009010000_viewer_outbox_triggers/migration.sql`)
  - Verify: drift check + Phase 3 bus tests
  - Files: that file
  Six `AFTER INSERT` and six `AFTER UPDATE` triggers (MySQL has no `INSERT OR UPDATE`) on `Run`, `CodingRunServiceStatus`, `IssuePullRequest`, `RunHostStatus`, `RunIssueStatus`, `RunHostCheck`, inserting JSON payloads equal to `wardby_viewer_notify()` output (kinds `run`/`service`/`outcome`, same field names, ISO-8601 `Z` `finishedAt`, `costUsd` as number). `Run` UPDATE trigger skips when status/turns/costUsd/tokensIn/tokensOut/finishedAt/parentRunId are all `<=>`-equal. Each insert wrapped in `DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN END` so a failure never fails the write.

- [ ] **Config selection** (`prisma.config.ts`, `prisma/migrate.config.mjs`)
  - Verify: `DATABASE_URL=mysql://u:p@h/db npx prisma validate` and `DATABASE_URL=postgresql://… npx prisma validate` both succeed
  - Files: those two
  Pick `prisma/mysql/schema.prisma` + `prisma/mysql/migrations` when `DATABASE_URL` (or `MIGRATION_DATABASE_URL`) scheme is `mysql://`/`mariadb://`; otherwise unchanged paths. Unknown scheme: leave Postgres default (runtime guard in `db.ts` reports the error).

- [ ] **Generate both clients and ship both** (`package.json`, `deploy/Dockerfile`, `.gitignore`)
  - Verify: `npm run build && ls dist/generated/prisma-mysql/client.js dist/generated/prisma/client.js`
  - Files: `package.json` (`prisma:generate` runs both configs; `build`/`prepare` likewise; `imports["#prisma-mysql"]` mirroring `#prisma`; `files` adds `prisma/mysql/migrations`, `prisma/mysql/schema.prisma`; dependency `@prisma/adapter-mariadb` 7.10.0), `deploy/Dockerfile` (extend the check at `:53,66` to require both client outputs and the adapter), `.gitignore` already covers `src/generated/`.

- [ ] **Drift-check scripts** (`package.json`, `scripts/db-drift.mjs`)
  - Verify: `npm run db:drift && npm run db:drift:mysql` both print `-- This is an empty migration.`
  - Files: `scripts/db-drift.mjs` runs the CLAUDE.md procedure for the chosen dialect (create `wardby_shadow`, `prisma migrate diff --from-migrations … --to-schema … --script --exit-code`, drop shadow, exit non-zero on diff). MySQL shadow DB is created on the local MySQL container from Phase 4; until then the script takes `SHADOW_DATABASE_URL` and a server it can create a database on.

- [ ] **Schema/migration parity test** (`src/core/db/schema-parity.test.ts`)
  - Verify: `npx vitest run src/core/db/schema-parity.test.ts`
  - Files: that file — asserts both schemas define the same set of model names and field names (modulo the documented differences: 12 list fields' type, `contentTsv`, `AdvisoryLock`, `ViewerEvent`), so a future Postgres-only schema edit fails CI.

## Success Criteria

### Automated Verification:
- [ ] `npx prisma validate` for both schemas
- [ ] `npm run db:drift` and `npm run db:drift:mysql` clean
- [ ] `sha256sum prisma/migrations/*/migration.sql` identical to the pre-change snapshot
- [ ] `npm run typecheck && npm run build`
- [ ] `npm test` on Postgres unchanged
- [ ] Baseline replays on an empty MySQL 8.4 and the seed rows exist: `SELECT COUNT(*) FROM CodingService WHERE builtin` equals the Postgres count on a migrated Postgres.

### Manual Verification:
- [ ] You compare a sample of tables (Run, CodingProxyRequest, AgentMemory, DatastoreEntry) between the two schemas.
- [ ] The CHECK constraints reject the same bad rows on both engines.

**Implementation Note**: pause for confirmation before Phase 3. CLAUDE.md update (two-migration rule, MySQL drift procedure) is deferred to Phase 6 and needs your approval.

## References
- Spec: Data Model, Decisions 2, 3, 6, 7, 10
- Postgres schema: `prisma/schema.prisma:1-1427`
- Seed rows: `prisma/migrations/20260927050000_coding_run_services/migration.sql:39`
