# MySQL Phase 1: Dialect seam

**Spec:** `.claude/thoughts/investigations/2026-10-09-mysql-core-database-spec.md`
**Jira:** none yet
**Depends on:** Phase 0 findings confirmed

---

## Overview

Introduce `src/core/db/dialect.ts` and move every Postgres-specific statement, lock, error classifier and listen mechanism behind it. Only the Postgres implementation exists after this phase, and **behaviour on Postgres must not change** (SQL text moves verbatim). This makes Phase 3 an additive implementation task and lets the refactor be reviewed on its own.

## Current State Analysis

Raw SQL lives in 16 non-test files (investigation §4). Postgres-specific error handling is in `src/mcp/errors.ts:54-117`, `src/core/dispatch.ts:150-189`, `src/core/issue-dedupe.ts:294-305`. The event bus is created in `src/mcp/index.ts:392-405` from `src/viewer/event-bus.ts`. `src/core/db.ts:73-87` builds the only client.

### Key Discoveries
- Memory and datastore providers are already named `postgres.ts` behind provider seams (`src/providers/{memory,datastore}/postgres.ts`); keep their public classes, move SQL into the dialect.
- `runner.ts`, `host-events.ts`, `reconciler.ts` contain no SQL; they only pass a db handle (no change).
- `grants-cli.ts` `ReportDb` takes only `$queryRaw` (`:30-32`) by design; the dialect supplies catalog probes so it still works against a schema the client does not match.
- `src/core/review-fix.ts:120` uses `triggers: { has: "review_fix" }`.

## Changes Required

- [ ] **Define the interface and selector** (`src/core/db/dialect.ts`, `src/core/db/index.ts`)
  - Verify: `npm run typecheck`
  - Files: `src/core/db/dialect.ts`, `src/core/db/index.ts`
  ```ts
  export type DialectName = "postgresql" | "mysql";
  export function dialectFromUrl(url: string | undefined): DialectName; // throws on unknown scheme
  export interface Dialect {
    readonly name: DialectName;
    // locks
    lockBudgetGroupDispatch(tx: Tx): Promise<void>;
    lockAgentRowSkipLocked(tx: Tx, agentId: string): Promise<boolean>;
    advisoryXactLock(tx: Tx, key: LockKey): Promise<void>;
    lockRowForUpdate(tx: Tx, table: "AuthUser" | "OAuthFamily" | "CodingProxySession" | "CodingProxyRequest", id: string): Promise<boolean>;
    setLockTimeout(tx: Tx, ms: number): Promise<void>;
    beginReadOnlyWithTimeout(tx: Tx, ms: number): Promise<void>;
    // statements
    tryAcquireLease(db: Db, scope: string, holder: string, ttlMs: number): Promise<boolean>;
    // …query methods listed in spec Decision 4
    // errors
    isSerializationConflict(err: unknown): boolean;
    isLockTimeout(err: unknown): boolean;
    uniqueViolationFields(err: unknown, modelName?: string): string[];
    listFilter(field: string, value: string): unknown;
    createEventBus(opts: EventBusOptions): ViewerEventBus;
  }
  ```
  `LockKey` is a discriminated union (`"budget-group-dispatch" | "oauth-client-capacity" | "coding-slots" | { issueDedupe: string }`) so each dialect maps names to its own mechanism.

- [ ] **Postgres implementation, moving SQL verbatim** (`src/core/db/dialect-postgres.ts`)
  - Verify: `npx vitest run src/core/lease.test.ts src/core/dispatch.test.ts`
  - Files: `src/core/db/dialect-postgres.ts`
  - Contents come from: `lease.ts:16-27`, `dispatch.ts:244,572-578`, `issue-dedupe.ts:168-172`, `auth/self-hosted.ts:137,299,357`, `executor/container.ts:65,288`, `credentials.ts:42,85,109,138`, `cost-report.ts:209-211`, `prisma-ledger.ts` statements.

- [ ] **Rewire core callers** (`src/core/lease.ts`, `src/core/dispatch.ts`, `src/core/issue-dedupe.ts`, `src/core/cost-report.ts`, `src/core/issue-status.ts`)
  - Verify: `npm run typecheck && npx vitest run src/core`
  - Files: those five; also `src/core/related-pull-requests.ts`, `src/core/secrets.ts` (second batch if >5)
  - Callers receive the dialect via an optional trailing `dialect = getDialect()` parameter so existing tests that pass a fake db keep working.

- [ ] **Rewire providers** (`src/providers/memory/postgres.ts`, `src/providers/datastore/postgres.ts`, `src/providers/coding-proxy/prisma-ledger.ts`, `src/providers/auth/self-hosted.ts`, `src/providers/executor/container.ts`)
  - Verify: `npx vitest run src/providers`
  - Files: those five

- [ ] **Rewire MCP auth and CLI** (`src/mcp/auth/self-hosted/credentials.ts`, `src/mcp/auth/self-hosted/rate-limit.ts`, `src/mcp/auth/grants-cli.ts`, `src/quickstart/index.ts`, `src/core/review-fix.ts`)
  - Verify: `npx vitest run src/mcp/auth src/quickstart src/core/review-fix.test.ts`
  - Files: those five; `review-fix.ts` uses `dialect.listFilter("triggers", "review_fix")` which on Postgres returns `{ has: "review_fix" }`.

- [ ] **Delegate error classifiers** (`src/mcp/errors.ts`, `src/core/dispatch.ts`, `src/core/issue-dedupe.ts`)
  - Verify: `npx vitest run src/mcp src/core/issue-dedupe.database.test.ts`
  - Files: those three. `isSerializationConflict`, `isLockTimeout`, `uniqueFields` keep their exported names and signatures and call the active dialect.

- [ ] **Event bus factory** (`src/mcp/index.ts`, `src/viewer/event-bus.ts`)
  - Verify: `npx vitest run src/viewer`
  - Files: `src/mcp/index.ts` calls `dialect.createEventBus`; Postgres factory returns the existing `createViewerEventBus` unchanged.

- [ ] **Dialect-selecting client factory** (`src/core/db.ts`)
  - Verify: `npx vitest run src/core/db.test.ts`
  - Files: `src/core/db.ts`; `createPrismaClient` calls `dialectFromUrl`; `postgresql://`/`postgres://` path identical to today; other schemes throw the error text from the spec's Acceptance Criteria (MySQL branch itself arrives in Phase 3).

- [ ] **Dialect unit tests** (`src/core/db/dialect.test.ts`)
  - Verify: `npx vitest run src/core/db/dialect.test.ts`
  - Files: `src/core/db/dialect.test.ts` — scheme parsing (`postgres://`, `postgresql://`, `mysql://`, `mariadb://`, garbage, undefined), Postgres `listFilter` shape, and a guard test asserting no file outside `src/core/db/dialect-*.ts` and tests contains the strings `pg_advisory_xact_lock`, `FOR UPDATE SKIP LOCKED`, `ON CONFLICT`, `LOCK TABLE` (prevents regressions that bypass the seam).

## Success Criteria

### Automated Verification:
- [ ] `npm run typecheck`
- [ ] `npm run lint && npm run format:check`
- [ ] `npm test` on Postgres unchanged (no test expectation edited)
- [ ] `npm run test:phase5:database` on Postgres
- [ ] `git diff --stat prisma/` is empty

### Manual Verification:
- [ ] Diff review: moved SQL strings are byte-identical to the originals.
- [ ] Quickstart on Postgres still starts, migrates and runs an agent.

**Implementation Note**: pause for confirmation before Phase 3 uses the seam.

## References
- Spec decisions 1, 4, 5: `.claude/thoughts/investigations/2026-10-09-mysql-core-database-spec.md`
- Provider seam pattern: `.okf/architecture/provider-seams.md`
- Investigation §4, §6, §7
