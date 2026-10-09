# MySQL Phase 5: Tests and CI matrix

**Spec:** `.claude/thoughts/investigations/2026-10-09-mysql-core-database-spec.md`
**Jira:** none yet
**Depends on:** Phase 3 complete; Phase 4 compose available for local runs

---

## Overview

Make the database test suites dialect-aware, add MySQL counterparts for the Postgres-only tests, and run everything against both databases in CI. After this phase a regression in either dialect fails CI.

## Current State Analysis

- 32 `*.database.test.ts` files plus ~11 other DB-gated tests use `describe.skipIf(!process.env.DATABASE_URL)`; no shared DB helper (each builds its own client or calls `createPrismaClient`).
- Five files import `pg` directly: `src/core/repo-access.database.test.ts`, `src/core/grants-migration.database.test.ts`, `src/mcp/auth/grants-cli.database.test.ts` (uses `search_path`), `src/viewer/notify.database.test.ts`, `src/viewer/event-bus.database.test.ts`.
- `src/core/prisma-adapter.database.test.ts` pins Postgres adapter error shapes.
- CI: `.github/workflows/security.yml:28-94` and `publish-npm.yml:16-48` start Postgres 16 services; no `ci.yml`.
- `deploy/gke/database-grants.database.test.mjs` tests Postgres-only grants SQL.

### Key Discoveries
- `CLAUDE.md` requires `npm test && npm run build` and the drift check before commit; CI should include both drift checks.
- `src/core/dispatch.test.ts:1436`, `src/core/db.test.ts:52-54`, `src/config/providers.test.ts:167-183` hardcode `postgresql://` URLs without a DB — they stay as is and gain MySQL URL cases.

## Changes Required

- [ ] **Shared test DB helper** (`src/test-support/db.ts`)
  - Verify: `npx vitest run src/test-support`
  - Files: `src/test-support/db.ts` (+ test)
  Exports `testDialect`, `describeDb(name, fn)` (skips when `DATABASE_URL` unset), `describePostgres`, `describeMysql`, `rawSql(client, sql, params)` and `withSchema(client, name)` hiding `pg` vs `mysql` differences (Postgres `search_path` vs MySQL `USE db`), and `truncateAll(prefix)` for the `pad-`-style cleanup.

- [ ] **Replace direct `pg` usage** (`src/core/repo-access.database.test.ts`, `src/core/grants-migration.database.test.ts`, `src/mcp/auth/grants-cli.database.test.ts`)
  - Verify: `npx vitest run <each file>` on both `DATABASE_URL`s
  - Files: those three — use `rawSql`/`withSchema`; no assertion text changes.

- [ ] **Parameterize adapter parity test** (`src/core/prisma-adapter.database.test.ts`)
  - Verify: both dialects pass
  - Files: that file — keep every assertion; expected raw-error shapes (e.g. P2010 vs deadlock shapes) come from a per-dialect table recorded in Phase 0; add MySQL deadlock (1213) and lock wait (1205) retry cases mirroring the 40001/40P01 ones.

- [ ] **Event bus tests per dialect** (`src/viewer/notify.database.test.ts`, `src/viewer/event-bus.database.test.ts`, `src/viewer/outbox.database.test.ts`)
  - Verify: both dialects pass
  - Files: the first two become `describePostgres`; the new `outbox.database.test.ts` (`describeMysql`) asserts the same payload table for each of the six tables (including heartbeat suppression on `Run`, never-fails-the-write on a forced trigger error, prune behaviour, cursor/gap/resync).

- [ ] **Postgres-only and MySQL-only markers** (`src/providers/memory/postgres.test.ts`, `src/providers/datastore/postgres.test.ts`, `src/providers/executor/dbos.database.test.ts`, `deploy/gke/database-grants.database.test.mjs`)
  - Verify: `npm test` on both
  - Files: those four — memory/datastore tests become dialect-agnostic contract tests (rename to `memory.contract.test.ts` and `datastore.contract.test.ts` via `git mv`) asserting contract, not scores; DBOS and GKE grants tests stay `describePostgres` (DBOS keeps using a Postgres `DBOS_SYSTEM_DATABASE_URL` even in the MySQL matrix leg, supplied by a Postgres service in that job).

- [ ] **Add MySQL URL cases to non-DB tests** (`src/core/db.test.ts`, `src/config/providers.test.ts`, `src/core/db/dialect.test.ts`)
  - Verify: `npx vitest run src/core src/config`
  - Files: those three — selection, unsupported scheme error, version guard (fake `VERSION()`), DBOS guard.

- [ ] **Concurrency regression tests** (`src/core/lease.test.ts`, `src/core/coding-concurrency.database.test.ts`, `src/core/budget-groups.database.test.ts`)
  - Verify: both dialects, repeat 20× for flake check: `for i in $(seq 20); do npx vitest run <files> || break; done`
  - Files: those three — assert the Acceptance Criteria invariants (single leader, no budget overspend, slot cap) under real parallel transactions.

- [ ] **CI matrix** (`.github/workflows/security.yml`, `.github/workflows/publish-npm.yml`)
  - Verify: `act`-free check — open the PR and confirm both legs run; locally `npx yaml-lint` not required
  - Files: those two
  Add a `database: [postgres, mysql]` matrix: `mysql` leg uses a `mysql:8.4` service with `--log-bin-trust-function-creators=1`, `DATABASE_URL=mysql://…`, a Postgres service for `DBOS_SYSTEM_DATABASE_URL`, runs `prisma:generate` (both), `prisma:migrate`, `npm test`, `test:phase5:database`, and both drift checks (`db:drift`, `db:drift:mysql`) in one leg. Credentials in workflow files are disposable test-only values, as the existing Postgres ones are.

- [ ] **Package acceptance** (`scripts/npm-package-acceptance.mjs`, `scripts/npm-package-acceptance-harness.mjs`)
  - Verify: `npm run test:package` against both URLs
  - Files: those two — replace the `pg.Client` throwaway-DB creation with dialect-aware creation (`CREATE DATABASE` on either), verify the packed tarball contains both generated clients and migrations.

## Success Criteria

### Automated Verification:
- [ ] `npm test` and `npm run test:phase5:database` pass on Postgres and MySQL
- [ ] No file imports `pg` outside `src/core/db/`, `src/viewer/event-bus.ts`, `src/test-support/`, `scripts/`
- [ ] Flake loop (20 iterations) green for concurrency tests on both dialects
- [ ] Both CI legs green on the PR; `npm run typecheck && npm run lint && npm run format:check`

### Manual Verification:
- [ ] Skim the CI run to confirm the MySQL leg actually executed the database suites (not skipped by an unset `DATABASE_URL`).
- [ ] Confirm no existing Postgres test expectation was weakened (review the test-file diff).

**Implementation Note**: pause for confirmation before Phase 6.

## References
- Spec: Acceptance Criteria (parity, concurrency, event bus)
- Investigation §9 (test inventory)
