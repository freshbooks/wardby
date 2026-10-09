# MySQL Phase 6: Docs and help

**Spec:** `.claude/thoughts/investigations/2026-10-09-mysql-core-database-spec.md`
**Jira:** none yet
**Depends on:** Phases 3–5 complete (documents final, verified behaviour)

---

## Overview

CLAUDE.md requires every operator-visible change to be evaluated for both `docs/` and `help/`, and requires public docs to be generic operator guidance (no test-run narrative, no our-infrastructure details, no PR history). This phase writes both surfaces, updates the OKF bundle, and — with your approval — CLAUDE.md.

## Current State Analysis

- `docs/` mentions Postgres in: `README.md:4,28`, `getting-started.md:4,31-32,79`, `getting-started-gke.md`, `coding-agent-setup.md`, `coding-services.md` (service catalog: Postgres, Redis, MySQL as per-run services), `agent-recipes.md`, `security-deployment.md:195,321,438-489,538,624-666` (PostgreSQL 13+, `dbos:migrate`, pg adapter), `architecture-runtime.md:4,32,38,51,59`, `viewer-api.md:131` (Postgres NOTIFY), `release-verification.md:4-5`, `coding-worker-isolation.md:420`.
- `README.md` lines 46, 54, 181, 255, 259, 352-357, 374.
- `help/`: `deploy-gke.md`, `coding-services.md`, `deployment-targets.md`, `agent-recipes.md`, `troubleshooting/coding-workers.md`, `errors/service-*.md`; bundled by `npm run build:help` into `dist/help-index.json` (required frontmatter: `id`, `title`, `summary`, `audience`, `tags`, `appliesTo`).
- OKF: `.okf/data/database-and-migrations.md`, `.okf/index.md`, `.okf/architecture/provider-seams.md`.

### Key Discoveries
- `docs/coding-services.md` already documents MySQL as a *per-run service*; the new docs must distinguish "wardby's own database" from "services a coding run can start" to avoid confusing operators (and `search_help` results).
- `docs/security-deployment.md:438-489` is the DBOS section and needs the MySQL exception.

## Changes Required

- [ ] **New guide: choosing and operating the database** (`docs/databases.md`)
  - Verify: `npx prettier --check docs/databases.md`
  - Files: `docs/databases.md` — supported engines and versions (PostgreSQL 13+ as documented today; MySQL 8.4+), how to select (`DATABASE_URL` scheme), URL examples (TLS options), required privileges per role (migrator vs app), MySQL server settings (`utf8mb4`/`utf8mb4_0900_bin`, `log_bin_trust_function_creators` with binary logging), migration commands, behaviour differences (memory search stemming/stopwords, event latency ~1 s polling, case-sensitive collation), DBOS exception, limits (no MariaDB, no cross-engine migration), backup notes. Generic placeholders only (`your-host`, `your-org`).

- [ ] **Update existing guides** (`docs/getting-started.md`, `docs/security-deployment.md`, `docs/architecture-runtime.md`, `docs/viewer-api.md`, `docs/README.md`)
  - Verify: `npx prettier --check docs`
  - Files: those five — quickstart `--database`, env-var/role tables (`DATABASE_URL`, `MIGRATION_DATABASE_URL`, `DBOS_SYSTEM_DATABASE_URL`, `VIEWER_POLL_INTERVAL_MS`, `WARDBY_MYSQL_*`), DBOS section exception, event-bus description for both engines, architecture diagram wording ("database" not "Postgres").

- [ ] **Deployment docs** (`README.md`, `deploy/README.md`, `deploy/gcp/SETUP.md`, `docs/getting-started-gke.md`)
  - Verify: `npx prettier --check README.md deploy docs/getting-started-gke.md`
  - Files: those four — README architecture/targets table and "Other clouds" row mention MySQL; GCP `database_engine` variable and MySQL flags; state that the GKE reference deployment is PostgreSQL-only.

- [ ] **Help articles** (`help/database-engines.md`, `help/errors/mysql-version-unsupported.md`, `help/errors/mysql-trigger-privilege.md`, `help/errors/dbos-requires-postgres.md`, `help/deployment-targets.md`, `help/deploy-gke.md`, `help/coding-services.md`)
  - Verify: `npm run build:help` then query the index (via the repo's help test or `tsx` script) for "mysql", "database", "DATABASE_URL", "dbos mysql", "trigger privilege", "binary log" and confirm each returns the right article first
  - Files: the three new articles plus link updates in the four existing ones. Required frontmatter on all; error articles use `help/errors/` per CLAUDE.md. `coding-services.md` gets a clarifying note that per-run MySQL service is unrelated to wardby's own database.

- [ ] **OKF bundle** (`.okf/data/database-and-migrations.md`, `.okf/index.md`, `.okf/architecture/provider-seams.md`)
  - Verify: `/okf:validate .okf --strict`
  - Files: those three (follow the `okf:okf` skill) — the concept now covers both engines, the two-migration rule, the layout and the dialect seam; mark newly written statements without a `verified` entry until code-checked.

- [ ] **CLAUDE.md** (ASK FIRST — wait for explicit approval of the exact text)
  - Verify: diff reviewed by you
  - Files: `CLAUDE.md` — "Database / Prisma" section gains: both engines, "every schema change ships a Postgres and a MySQL migration", the MySQL drift-check procedure (`npm run db:drift:mysql`), "never write raw SQL outside the dialect modules".

- [ ] **PR description** (at ship time)
  - States what was added to `docs/` and `help/` per the CLAUDE.md requirement.

## Success Criteria

### Automated Verification:
- [ ] `npm run build:help && npm test` (help build + help tests)
- [ ] `npx prettier --check .`
- [ ] `/okf:validate .okf --strict`
- [ ] Grep guard: `grep -rniE "verified on|confirmed live|app\.wardby\.com|knock-knock" docs help README.md deploy --include='*.md'` returns nothing new

### Manual Verification:
- [ ] A reader unfamiliar with the project can pick MySQL, size privileges and understand the differences from `docs/databases.md` alone.
- [ ] No tracked doc contains our project ids, hosts, test runs or PR history.

**Implementation Note**: this is the last phase; final review against the spec's Definition of Done.

## References
- Spec: Acceptance Criteria (operator docs), Dependencies (server requirements)
- CLAUDE.md sections "Public docs are for operators" and "Every feature gets a docs + help check"
