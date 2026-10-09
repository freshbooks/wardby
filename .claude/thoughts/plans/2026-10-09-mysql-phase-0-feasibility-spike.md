# MySQL Phase 0: Feasibility spike

**Spec:** `.claude/thoughts/investigations/2026-10-09-mysql-core-database-spec.md`
**Jira:** none yet
**Depends on:** None — first phase

---

## Overview

Verify, with throwaway code in the scratchpad (not committed), the assumptions the spec already decided on. This phase exists because `node_modules` was not installed during planning, so none of the Prisma/MySQL behaviour could be executed. Output: a short findings note appended to the spec's Change Log, and a go/no-go for each assumption below. Each assumption has a pre-decided fallback, so a failed check changes the implementation, not the scope.

## Current State Analysis

- Prisma 7.10.0 with `@prisma/adapter-pg` (`package.json:101-102`); no MySQL adapter installed.
- `src/core/db.ts:73-85` builds the client from one adapter.
- Local Postgres compose at `deploy/local/docker-compose.yml:2-19`.

### Key Discoveries
- The DBOS SDK depends on `pg` only (npm metadata for 4.27.6); Decision 9 relies on that.
- Prisma `@default("[]")` on `Json` for MySQL may not be emitted as a valid MySQL default (JSON columns cannot have literal defaults; expression defaults need parentheses). Fallback is defined in Decision 6.

## Changes Required

No repository changes except an optional compose file for the spike kept outside the repo.

- [ ] **Start MySQL 8.4 and a scratch Prisma project** (scratchpad dir)
  - Verify: `docker run -d --name wardby-mysql-spike -e MYSQL_ROOT_PASSWORD=spike -p 55306:3306 mysql:8.4` then `mysql -h127.0.0.1 -P55306 -uroot -pspike -e "select version()"` prints 8.4.x
  - Files: scratchpad only

- [ ] **A1 — Adapter + auth plugin:** `@prisma/adapter-mariadb` connects to MySQL 8.4 with the default `caching_sha2_password` user, over TLS and plain.
  - Verify: scratch script runs `SELECT 1` through `new PrismaClient({adapter})`
  - Fallback if it fails: document and set the user's auth plugin explicitly; if the adapter cannot do `caching_sha2_password` at all, stop and report (blocks the project).

- [ ] **A2 — ANSI_QUOTES via `initSql`:** a pool option sets `sql_mode` to include `ANSI_QUOTES` per session, and `SELECT "id" FROM "Run"` works.
  - Verify: scratch query using double-quoted identifiers returns rows
  - Fallback: dialect owns backtick-quoted copies of every raw statement (adds work to Phase 1/3; update spec Decision 4).

- [ ] **A3 — Json arrays and defaults:** a scratch model with a `Json` field round-trips `["a","b"]`; test `@default("[]")` and the expression-default migration fallback; confirm `migrate diff --exit-code` stays clean.
  - Verify: `npx prisma migrate diff --from-migrations … --to-schema … --exit-code`
  - Fallback: per Decision 6 (hand-written `DEFAULT (JSON_ARRAY())` + extension default).

- [ ] **A4 — Normalizing `$extends` and typing:** an extension converts Json↔`string[]` for chosen fields; verify `tsc` accepts assigning the extended MySQL client to the Postgres `PrismaClient` type via a documented cast.
  - Verify: `npx tsc --noEmit` on a scratch file
  - Fallback: introduce a narrow `Db` interface for the affected models and type the 12 fields' call sites against it.

- [ ] **A5 — Interactive Serializable + FOR UPDATE:** reproduce the dispatch pattern (lock row first, then read, write) with two concurrent transactions; observe deadlock errno 1213 and its Prisma error shape (`P2034` / `P2010` / `DriverAdapterError` and `cause.originalCode`).
  - Verify: scratch script prints the error object shape for 1213 and 1205
  - Output feeds `isSerializationConflict` in Phase 3.

- [ ] **A6 — Error shapes:** unique violation (1062) and FK violation (1451/1452): record `code`, `meta`, `meta.driverAdapterError.cause.constraint` for each.
  - Output feeds `uniqueViolationFields` and `mapPrismaError`.

- [ ] **A7 — Triggers under binlog:** create a trigger as a non-SUPER user with `log_bin=ON`, `log_bin_trust_function_creators=0`, then `=1`; record the error and the fix.
  - Output feeds operator docs (Phase 6) and the migration-failure guidance.

- [ ] **A8 — FULLTEXT behaviour:** natural-language search over `AgentMemory.content`-like data; confirm ranking returned as float and the stopword/min-token behaviour to document.

- [ ] **Record findings** — append a "Phase 0 findings" entry to the spec Change Log; update any decision whose fallback was triggered.
  - Files: `.claude/thoughts/investigations/2026-10-09-mysql-core-database-spec.md`

## Success Criteria

### Automated Verification:
- [ ] Each of A1–A8 has a recorded pass/fail and the observed error shapes in the spec Change Log.
- [ ] No tracked file changed: `git status --short` shows no modifications outside `docs/private/` (git-ignored).

### Manual Verification:
- [ ] You review the findings and confirm any triggered fallback before Phase 1/2 start.

**Implementation Note**: pause for confirmation after this phase.

## References
- Spec: `.claude/thoughts/investigations/2026-10-09-mysql-core-database-spec.md`
- Research: `.claude/thoughts/investigations/2026-10-09-database-layer-postgres-coupling.md`
