# MySQL Phase 4: Config, deploy and quickstart

**Spec:** `.claude/thoughts/investigations/2026-10-09-mysql-core-database-spec.md`
**Jira:** none yet
**Depends on:** Phase 3 complete (wardby runs on MySQL 8.4)

---

## Overview

Make MySQL selectable and deployable everywhere an operator touches the database: provider config and DBOS guard, local compose, quickstart/doctor, production compose, GCP Terraform (Cloud SQL for MySQL 8.4). Every value stays a variable; nothing test-specific is committed (CLAUDE.md Deployment rules).

## Current State Analysis

- `deploy/local/docker-compose.yml:2-19` runs `postgres:16-alpine` on `${WARDBY_POSTGRES_PORT:-55432}:5432`; `docker-compose.phase5.yml` and `deploy/observability/docker-compose.grafana.yml` point at `postgres:5432`.
- Quickstart: `src/quickstart/index.ts:123-161` (port selection 55432–55532), `:262,401-435,478-480,518,546` (Postgres vars, health, doctor), `src/quickstart/config.ts:12,100` (`postgresPort`), `src/quickstart/migrate.ts:80,142`.
- `src/config/providers.ts:484-516` `loadDbosConfig`.
- `deploy/gcp`: `cloudsql.tf` (`POSTGRES_16`), `secrets.tf:14` (URL builder), `cloud-run.tf:71`, `migration-job.tf:40`. `deploy/aws/` is empty.
- `deploy/production/compose.yml:99` migration service; `production.env.example:22-41,70`.
- `deploy/gke` is Postgres-specific (Cloud SQL Postgres, IAM, `database-grants.sql`).

### Key Discoveries
- `DBOS_SYSTEM_DATABASE_URL` already exists as a separate setting (`providers.ts:512`), so the DBOS rule is a guard, not a feature.
- `deploy/gke` (IAM auth, grants SQL, Postgres-flavoured Auth Proxy ports) is not extended in this project; docs state GKE reference deployment is Postgres-only. (Spec scope decision: GCP Cloud Run module gains MySQL; GKE module unchanged.)

## Changes Required

- [ ] **DBOS guard** (`src/config/providers.ts`, `src/config/providers.test.ts`)
  - Verify: `npx vitest run src/config/providers.test.ts`
  - Files: those two
  With a MySQL `DATABASE_URL` and `EXECUTOR=dbos`: require `DBOS_SYSTEM_DATABASE_URL` with a `postgresql://`/`postgres://` scheme; otherwise throw "EXECUTOR=dbos on a MySQL database requires DBOS_SYSTEM_DATABASE_URL pointing at a PostgreSQL database." The existing message for the missing-URL case is unchanged on Postgres.

- [ ] **Local compose, MySQL profile** (`deploy/local/docker-compose.yml`, `package.json`)
  - Verify: `npm run db:up:mysql && docker compose -f deploy/local/docker-compose.yml --profile mysql ps` shows healthy; `npm run db:down:mysql`
  - Files: compose file (service `mysql` under `profiles: ["mysql"]`, image `mysql:8.4`, port `${WARDBY_MYSQL_PORT:-55306}:3306`, env `WARDBY_MYSQL_USER/PASSWORD/DB`, healthcheck `mysqladmin ping`, volume `wardby-mysql-data`, `--log-bin-trust-function-creators=1`, `--character-set-server=utf8mb4`, `--collation-server=utf8mb4_0900_bin`); `package.json` adds `db:up:mysql`, `db:down:mysql`. Postgres service remains the default profile.

- [ ] **Phase5/observability compose overlays** (`deploy/local/docker-compose.phase5.yml`, `deploy/observability/docker-compose.grafana.yml`)
  - Verify: `docker compose … config` renders for both profiles
  - Files: those two — `DATABASE_URL` and the dependency become `${DATABASE_URL}` driven by `.env.local`, with `depends_on` targeting the active service name.

- [ ] **Quickstart database choice** (`src/quickstart/index.ts`, `src/quickstart/config.ts`, `src/quickstart/migrate.ts`, `src/quickstart/doctor` paths in `index.ts`)
  - Verify: `npx vitest run src/quickstart`
  - Files: those three (+ tests)
  Prompt "PostgreSQL (default) or MySQL"; flag `--database postgres|mysql`; generalise `selectPostgresPort`/`startPostgres`/`databaseUrl` to a `selectDbPort`/`startDatabase`/`databaseUrl(dialect)` pair keeping the 55432 range for Postgres and 55306–55406 for MySQL; persist `database` and `databasePort` in quickstart config with backward-compatible reading of `postgresPort`; `doctor` prints dialect, version (`checkServer`), trigger/outbox presence; migrate step uses `prisma/migrate.config.mjs` selection from Phase 2.

- [ ] **Production compose and env example** (`deploy/production/compose.yml`, `deploy/production/production.env.example`, `scripts/production-boundary-policy.mjs`)
  - Verify: `npm run test:production-boundary`
  - Files: those three
  Examples gain a MySQL `DATABASE_URL`/`MIGRATION_DATABASE_URL` (`mysql://…?ssl-mode=VERIFY_IDENTITY` form accepted by the adapter, verified in Phase 0 A1) and the comment block about the DBOS Postgres exception; the boundary policy regex keeps asserting the migration line shape.

- [ ] **GCP Cloud Run module: engine variable** (`deploy/gcp/variables.tf`, `deploy/gcp/cloudsql.tf`, `deploy/gcp/secrets.tf`, `deploy/gcp/cloud-run.tf`, `deploy/gcp/migration-job.tf`)
  - Verify: `terraform -chdir=deploy/gcp init -backend=false && terraform -chdir=deploy/gcp validate` and `terraform fmt -check -recursive deploy/gcp`
  - Files: those five (+ `outputs.tf` if it references the engine)
  New variable `database_engine` (`"postgres"` default, `"mysql"`), validated. `database_version` becomes engine-aware (`POSTGRES_16` / `MYSQL_8_4`); MySQL path adds the `log_bin_trust_function_creators = on` database flag, character set/collation flags, a `mysql` user and database resources instead of the Postgres role/ownership pieces; the secret URL builder emits `mysql://user:pass@localhost/db?socket=/cloudsql/…` (Phase 0 A1 confirms the socket parameter form); migration job runs `prisma migrate deploy` with the Phase 2 config selection. All names/ids remain variables; no tfvars committed.

- [ ] **GCP docs stub and SETUP** (`deploy/gcp/SETUP.md`, `deploy/README.md`)
  - Verify: `npx prettier --check deploy/gcp/SETUP.md deploy/README.md`
  - Files: those two — operator-voice sections only (engine variable, MySQL flags, DBOS exception); full guide updates happen in Phase 6.

## Success Criteria

### Automated Verification:
- [ ] `npx vitest run src/config src/quickstart`
- [ ] `terraform validate` and `terraform fmt -check` for `deploy/gcp`
- [ ] `npm run test:production-boundary`
- [ ] `npm run typecheck && npm run lint && npm run format:check`
- [ ] `npm run db:up:mysql` healthy and `DATABASE_URL=mysql://… npx prisma migrate deploy` applies baseline + triggers

### Manual Verification:
- [ ] `wardby quickstart --database mysql` on a clean machine: starts MySQL, migrates, serves, `doctor` green.
- [ ] Quickstart default (Postgres) unchanged.
- [ ] You review the Terraform plan output locally for both engines (plan output stays local; never committed).

**Implementation Note**: pause for confirmation before Phase 5.

## References
- Spec: Dependencies, Decisions 1, 9
- `deploy/local/docker-compose.yml:2-19`, `src/quickstart/index.ts:123-161`, `src/config/providers.ts:484-516`, `deploy/gcp/cloudsql.tf:7-49`
