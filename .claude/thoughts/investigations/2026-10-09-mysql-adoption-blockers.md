# Blockers to adopting MySQL as a wardby core database

**Date:** 2026-10-09
**Status:** parked — no implementation started; branch saved for future reference
**Related:** `2026-10-09-database-layer-postgres-coupling.md` (research), `2026-10-09-mysql-core-database-spec.md` (spec), `.claude/thoughts/plans/2026-10-09-mysql-phase-*.md` (plans)

## Bottom line

MySQL 8.4+ as a configurable alternative to PostgreSQL is **feasible but large**: a second schema, migration chain, generated client and SQL dialect, plus new lock, event and search mechanisms. Nothing found is impossible. The real blockers are one hard limit (DBOS), a correctness risk (concurrency), several unverified assumptions, and a permanent maintenance cost with no identified customer demand yet.

## Blockers, most serious first

1. **DBOS cannot run on MySQL.**
   The optional durable executor (`EXECUTOR=dbos`) uses `@dbos-inc/dbos-sdk` 4.27.6, which depends only on `pg` and documents a Postgres-compatible system database (SQLite for dev). "Everything on MySQL" is therefore not achievable without building a wardby-native durable executor (a project of its own). Planned workaround: on MySQL, `EXECUTOR=dbos` requires a separate Postgres via `DBOS_SYSTEM_DATABASE_URL`. Operators who need durable runs still have to run Postgres.

2. **Concurrency correctness must be re-engineered and re-proven.**
   Budget enforcement, dispatch, the scheduler lease and OAuth capacity rely on Postgres primitives with no drop-in MySQL equivalent:
   - `LOCK TABLE "BudgetGroup" … SHARE ROW EXCLUSIVE` (`dispatch.ts:244`): MySQL `LOCK TABLES` implicitly commits the open transaction, so it is unusable.
   - `pg_advisory_xact_lock` (3 sites): MySQL `GET_LOCK` is session-scoped, not transaction-scoped. Plan: lock-row table with `SELECT … FOR UPDATE`.
   - `INSERT … ON CONFLICT … RETURNING` (lease, rate limiter, ledger): MySQL has no `RETURNING`.
   - Serializable isolation: InnoDB uses locking reads, so deadlocks (1213) and lock-wait timeouts (1205) replace Postgres serialization failures, and are more frequent.
   A subtle bug here means overspent budgets or double dispatch, which is the product's core guarantee. This needs real parallel-transaction tests on MySQL, not just a port.

3. **No `LISTEN/NOTIFY`; managed-MySQL privilege friction.**
   The viewer's live updates use Postgres triggers + `pg_notify` + a dedicated listener connection. MySQL needs an outbox table, triggers and polling (~1 s latency). Creating triggers with binary logging on requires `log_bin_trust_function_creators=1` or `SUPER`, which some managed services restrict or expose only as a flag.

4. **Schema divergence is permanent.**
   - 12 `String[]` fields become `Json`; generated types then differ and need a normalizing Prisma extension (untested), and one array filter (`review-fix.ts:120`, `has`) has no `Json` equivalent.
   - `tsvector` + GIN full-text memory search becomes InnoDB `FULLTEXT` with different behaviour (no English stemming, stopwords, minimum token size). Same API, different results.
   - 10 enums, hand-written CHECK constraints, collation (`utf8mb4_0900_bin` needed to match Postgres case-sensitivity), 191-char key limits.
   - Every future schema change ships two migrations and two drift checks. Every future raw query is dialect-aware. This cost never ends.

5. **Large raw-SQL surface.**
   About 16 non-test files use Postgres-specific SQL (`::` casts, `FILTER`, `NULLS LAST`, recursive CTEs, `octet_length`, `starts_with`, `UPDATE … FROM … RETURNING`, savepoints, `IS DISTINCT FROM`, `to_regclass`). All must move behind a dialect layer and be reimplemented.

6. **Key assumptions are unverified (Phase 0 spike never run).**
   `node_modules` was not installed during planning, so none of this was executed:
   - `@prisma/adapter-mariadb` against MySQL 8.4 with `caching_sha2_password`, TLS and socket URLs.
   - Setting `ANSI_QUOTES` per session so quoted-identifier SQL can be shared.
   - Prisma emitting a valid `Json` default (`[]`) on MySQL.
   - The exact error shapes for deadlock, unique and FK violations through the adapter.
   - The type-casting approach for the Json↔`string[]` extension.
   Any of these failing changes the design (fallbacks are written into the spec).

7. **Deployment and test surface doubles.**
   - Local compose, quickstart, production compose, GCP Terraform (Cloud SQL MySQL flags/users/URL form) all need MySQL paths. The GKE reference deployment (IAM auth, grants SQL) is Postgres-specific and would stay Postgres-only. `deploy/aws/` is empty.
   - About 32 `*.database.test.ts` files plus ~11 DB-gated tests must run on both engines; 5 files use `pg` directly; Postgres-only tests need MySQL counterparts. CI time and flake surface grow.

8. **Docs and help burden.**
   CLAUDE.md requires `docs/` and `help/` for every operator-visible change: a new database guide, edits to ~10 guides, new help and error articles, OKF updates, and a CLAUDE.md change that needs approval.

9. **Product question: who needs it?**
   No customer or operator demand, ticket, or Jira story was identified. Cheaper alternatives to evaluate first: easier managed-Postgres setup, or a smaller scope (MySQL only for the agent datastore, or the per-run MySQL service that already exists). Customer impact is only real if operators genuinely cannot run Postgres.

## What is *not* a blocker

- MySQL 8.4 supports `SKIP LOCKED`, recursive CTEs, `CHECK`, native JSON, `FULLTEXT`, savepoints, `ON DUPLICATE KEY UPDATE`.
- Prisma 7 can be pointed at MySQL via a driver adapter; the Postgres schema and 66 migrations stay untouched under the chosen layout.
- The Postgres path can be kept byte-identical (a refactor-only Phase 1 proves it).

## If revived

Run Phase 0 first (a short throwaway spike, no repo changes), then Phase 1 (dialect seam, Postgres behaviour unchanged — valuable on its own because it isolates Postgres-specific SQL). Re-confirm demand and create a DEVXP story before Phase 2. Re-verify the file/line references in the research doc against the then-current `main`; they were taken at commit `5f68c9e`.

Rough size: seven phases touching ~100 files plus Terraform, CI and docs. The concurrency work and the Phase 0 findings drive the uncertainty.
