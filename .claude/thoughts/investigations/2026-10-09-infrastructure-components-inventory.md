---
date: 2026-10-09T18:28:41+0000
researcher: Claude (Sonnet 5.5) for fbrodrigorezino
git_commit: f6f7f2a (code identical to 5f68c9e)
branch: add-support-for-mysql
repository: wardby
topic: "Inventory of every infrastructure component wardby uses"
tags: [research, codebase, infrastructure, inventory, deploy, terraform, kubernetes, ci]
status: complete
last_updated: 2026-10-09
last_updated_by: Claude (Sonnet 5.5)
---

# Research: Infrastructure components inventory

**Date**: 2026-10-09T18:28:41+0000
**Git Commit**: f6f7f2a
**Branch**: add-support-for-mysql
**Repository**: wardby

## Research Question

List every infrastructure component the project uses: runtime, data stores, external services, containers and orchestration, cloud and IaC, networking, observability, CI/CD and supply chain, and local development tooling.

## Summary

wardby is a Node.js 24 / TypeScript control plane plus a trusted LLM proxy and per-run sandboxed coding workers. It stores data in PostgreSQL (through Prisma), runs on Kubernetes (GKE Autopilot or kind), Docker Compose, or Cloud Run (deprecated reference), and calls LLM, GitHub, Jira and identity providers over HTTPS. Terraform covers GCP; `deploy/aws/` is an empty placeholder. Prometheus and Grafana exist only in a local overlay. CI is GitHub Actions with Trivy, Anchore SBOM and CodeQL.

Sources: `package.json`, `deploy/**`, `.github/workflows/*`, `src/providers/**`, `src/config/providers.ts`, `src/observability/**`, and the earlier investigation documents listed under Historical Context. Items marked *(not verified)* were located but not read in depth.

## Detailed Findings

### 1. Application runtime

| Component | Detail | Where |
|---|---|---|
| Node.js 24 | image `node:24.21.0-bookworm-slim`, TypeScript, ESM | `deploy/Dockerfile` |
| MCP server | Model Context Protocol over HTTP (and stdio), `@modelcontextprotocol/*` | `src/mcp`, `package.json` |
| Scheduler + reconciler | leader-elected through a database lease (10 s tick, 30 s TTL, 15 s reconcile) | `src/core/scheduler.ts`, `reconciler.ts`, `lease.ts` |
| Viewer | admin API (`/admin/api/*`) with an SSE event stream, web app in `apps/viewer`; served by the MCP HTTP server | `src/viewer`, `apps/viewer` |
| Coding proxy | separate trusted process; metering, budget ledger, registry mirror; ports 8787 (proxy) and 8788 (deny/witness) | `src/coding-proxy`, `src/providers/coding-proxy` |
| Coding workers | untrusted per-run containers: Codex worker, Claude worker, Claude tool runner, keeper | `src/coding-worker`, `src/claude-coding-worker`, `src/claude-tool-runner` |
| Sandbox | QuickJS (`quickjs-emscripten`) for agent tool code | `src/sandbox` |
| Executors | in-process, container, DBOS (durable) | `src/providers/executor` |
| Libraries of note | `pino` (logging), `@prometheus-io/client`, `croner`, `jose`, `undici`, `zod` | `package.json` |
| Static site | landing page `site/` served through GitHub Pages | `site/`, `.github/workflows/pages.yml` |

### 2. Data stores and state

| Component | Detail | Where |
|---|---|---|
| PostgreSQL | 16 in local/CI/GCP/GKE; documented minimum 13 (`gen_random_uuid`); Prisma 7.10.0 + `@prisma/adapter-pg` + `pg` 8.23.0; 54 models, 66 migrations; also locks, upserts, `LISTEN/NOTIFY` | `prisma/`, `src/core/db.ts` |
| DBOS system schema | optional executor state in a `dbos` schema of the same (or a separate) Postgres; `@dbos-inc/dbos-sdk` 4.27.6 | `src/providers/executor/dbos.ts` |
| Per-run services: PostgreSQL, Redis, MySQL 8 | **Not wardby's own storage.** Throwaway containers a coding run can start next to its worker to test the repository under work (declared in the repo's `.wardby/services.yaml`). Built-in catalog entries use pinned `docker.io/library/*` image digests (`redis`, `mysql` 8, `postgres`); seeded by migration. This is the only place MySQL is used today. | `src/coding/services/builtins.ts:61-92`, migration `20260927050000_coding_run_services`, `docs/coding-services.md:127` |
| Local filesystem | coding artifacts and job state (`CODING_ARTIFACT_ROOT`, `CODING_JOB_STATE_ROOT`, `VCS_WORK_ROOT`); `BLOB_STORE` and `DATASTORE` are provider seams | `src/config/providers.ts` |
| Model catalog | shipped pricing/model catalog persisted in the database | `src/providers/llm/catalog-*.ts` |

**MySQL is not a supported database for wardby itself.** Core storage is PostgreSQL only; MySQL support as a core database is a parked proposal (see Historical Context) with no code, schema or deploy changes. `mysql2` appears only under `package.json` `overrides` (pinned 3.24.4, an audit pin); it is not a dependency.

### 3. External services (outbound over HTTPS)

| Service | Used for | Where |
|---|---|---|
| Anthropic API | LLM calls; Claude coding worker via the proxy (`https://api.anthropic.com/v1/messages?beta=true`) | `src/providers/llm/anthropic.ts`, `coding-proxy/proxy.ts:930-931` |
| Amazon Bedrock | LLM provider (`@anthropic-ai/bedrock-sdk`) | `src/providers/llm/bedrock.ts` |
| OpenAI | LLM provider and Codex worker (`https://api.openai.com/v1/responses`), `@openai/codex-sdk` (dev) | `src/providers/llm/openai.ts` |
| GitHub | GitHub App (VCS, clone, pull requests, review host, webhooks, OAuth user auth) | `src/providers/vcs/github.ts`, `review-host/` |
| Jira / Atlassian | issue tracker via `https://api.atlassian.com/ex/jira/<cloudId>`, webhooks | `src/providers/issue-tracker/` |
| Package registries | npm (`registry.npmjs.org`), PyPI (`pypi.org`, `files.pythonhosted.org`), OSV (`api.osv.dev`) through the proxy | `src/coding/registry`, `coding-proxy/runtime.ts:79-82` |
| Identity provider | external OIDC via JWKS (delegating mode) or the built-in OAuth authorization server (self-hosted mode) | `src/providers/auth/` |
| Email | provider seam declared (`EMAIL_PROVIDER`) *(only a types file found)* | `src/providers/email/types.ts` |

### 4. Containers and Kubernetes

| Component | Detail | Where |
|---|---|---|
| Images built here | `wardby-runtime`, `wardby-migration`, `wardby-coding-worker-driver` (published to `ghcr.io`), Codex worker (+ node-python variant), Claude worker, Claude tool runner (+ node-python) | `deploy/Dockerfile`, `src/*/Dockerfile*`, `deploy/gke/docker-bake.hcl` |
| Pinned third-party images | `postgres:16-alpine`, `gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.25.4`, `prom/prometheus:v3.5.0`, `grafana/grafana:12.0.0`, `quay.io/keycloak/keycloak:26.0`, `registry.k8s.io/pause:3.10.1`, Caddy (digest supplied through `CADDY_IMAGE`) | `deploy/**`, `src/providers/jobs/` |
| Job launchers | Docker (`src/providers/jobs/docker*.ts`) or Kubernetes (`@kubernetes/client-node`, `kubernetes*.ts`) with runtime class `gvisor`, priority classes, resource quota, per-run NetworkPolicy | `src/providers/jobs/` |
| Kubernetes targets | kind (local) and GKE Autopilot, namespace `wardby-coding`; kustomize base + overlays `kind` and `gke-autopilot` | `deploy/kind-coding/` |
| Workloads | control plane Deployment (`node dist/cli.js serve`, 8080), coding proxy Deployment (8787/8788), migrate Job, per-run worker pods, `cloud-sql-proxy` native sidecars | `overlays/gke-autopilot/`, `base/proxy.yaml` |
| Gateway | GKE L7 external managed Gateway, HTTPRoutes (HTTPS + redirect), `GCPBackendPolicy` (Cloud Armor policy, 3600 s timeout), `HealthCheckPolicy` | `control-plane-gateway.yaml` |
| Secrets operator | External Secrets Operator (Helm, namespace-scoped) with `SecretStore gcp-secret-manager`, `ExternalSecret`s for the control plane, proxy and Jira, and a canary; directory `overlays/gke-autopilot/secrets/` has its own kustomization and is applied separately | `deploy/gke/eso-values.yaml`, `overlays/gke-autopilot/secrets/` |
| Network policy | namespace default-deny; per-workload allows; workers can reach only the proxy on 8787 | `base/default-deny.yaml`, `base/proxy.yaml`, `kubernetes-isolation.ts` |
| Quota and RBAC | ResourceQuota (20 pods, 8 CPU, 16 Gi), launcher Role and namespace-reader, `automountServiceAccountToken: false` on workers and proxy | `base/quota.yaml`, `launcher-role.yaml`, `service-accounts.yaml` |
| Docker Compose | local Postgres, coding-proxy overlay, observability overlay, Keycloak test IdP, production stack (Caddy edge + mcp + scheduler + migrate) | `deploy/local`, `deploy/observability`, `deploy/keycloak-test`, `deploy/production` |

### 5. Cloud and infrastructure as code (Terraform)

Providers in use: `google`, `random`, `tls`, `null`.

**`deploy/gcp` (Cloud Run reference; documented as deprecated)**
- Cloud Run v2 service and migration job; Cloud Run domain mapping (optional).
- Cloud SQL (Postgres 16) instance, database, user; reached through the `/cloudsql` socket volume.
- Secret Manager secrets, versions and IAM members; service account and project IAM binding.
- Global HTTPS load balancer: serverless NEG, backend service, URL map, HTTPS proxy, global address and forwarding rule, managed or self-signed certificate; Cloud Armor security policy (per-IP rate limit).

**`deploy/gke` (GKE reference)**
- GKE cluster, Cloud SQL (Postgres 16, private IP, service networking peering, connector enforcement), database IAM auth and a grants job (`database-grants.sql`).
- Artifact Registry repository, Secret Manager, service accounts and Workload Identity bindings, global address for the Gateway.
- APIs enabled: IAM, Secret Manager, Service Networking.
- Scripts: `up.sh`, `bootstrap-database-iam.sh`, `seed-secrets.mjs`, `verify-eso-kind.sh`.

**AWS:** `deploy/aws/` contains only `.gitkeep`.

### 6. Networking and edge

| Component | Detail |
|---|---|
| Caddy | production-compose edge: automatic HTTPS (ACME), HSTS, 1 MB request body cap, 1 h write timeout for SSE, ports 80/443 |
| GKE Gateway + Cloud Armor | external HTTPS on 443 (80 redirects), LB health-check ranges 130.211.0.0/22 and 35.191.0.0/16 allowed to port 8080 |
| Cloud Run + Cloud Armor | internal-LB-only ingress when Cloud Armor is enabled |
| Cloud SQL Auth Proxy | sidecar in control plane, proxy, migrate Job and grants Job; DB on 127.0.0.1:5432, health on 9090, Cloud SQL on 3307 |
| DNS | node-local DNS 169.254.20.10 and kube-dns allowed on GKE; worker pods use `dnsPolicy: None` with a host alias to the proxy |
| Egress | control plane and proxy: non-private TCP 443; workers: proxy only; metadata servers 169.254.169.254/.252 on 80/988 for Workload Identity |

### 7. Observability

| Component | Detail | Where |
|---|---|---|
| Logging | `pino` JSON to stderr; no log shipper or sink configured in this repo | `src/core/logger.ts` |
| Prometheus metrics | `@prometheus-io/client`; `/metrics` and `/healthz` on `METRICS_BIND`; coding-proxy process only; off by default | `src/observability/` |
| Prometheus server | `prom/prometheus:v3.5.0`, local overlay only, 24 h retention, scrapes `coding-proxy:9464` | `deploy/observability/prometheus.yml` |
| Grafana | `grafana/grafana:12.0.0`, local overlay only, two provisioned dashboards (`wardby-coding-proxy`, `wardby-coding-budget`) | `deploy/observability/grafana/` |
| Not present | OpenTelemetry, Datadog, tracing, alerting rules, cloud collectors | (docs say operators bring their own) |

### 8. CI/CD, packaging and supply chain

| Component | Detail | Where |
|---|---|---|
| GitHub Actions | `security.yml` (checks, tests, package acceptance, image scans), `publish-npm.yml`, `publish-driver-image.yml`, `pages.yml`, `codeql.yml`, `codeql-rust.yml`, `claude.yml`, `claude-code-review.yml` | `.github/workflows/` |
| Service containers in CI | Postgres 16 for tests and package acceptance | `security.yml`, `publish-npm.yml` |
| Security scanning | Trivy (`aquasecurity/trivy-action`), SBOM (`anchore/sbom-action`), CodeQL; Dependabot notice on push | workflows |
| Registries | GHCR (`ghcr.io/<repo>/wardby-coding-worker-driver`), npm package, GKE Artifact Registry | `publish-driver-image.yml`, `publish-npm.yml`, `deploy/gke/cloudsql.tf`-adjacent files |
| Claude Code actions | `anthropics/claude-code-action` for review and mention workflows | `claude*.yml` |
| Action pinning | all actions pinned by commit SHA | workflows |
| Test tooling | Vitest 4, Playwright (viewer), ESLint 10, Prettier, TypeScript 5.6+, esbuild, tsx | `package.json` |

### 9. Local development tooling

- Docker / Docker Compose (`deploy/local`, `db:up`, `coding:local:up`, `observability:up`), `kind` cluster (`deploy/kind-coding/kind-config.yaml`), Keycloak test realm (`deploy/keycloak-test`).
- `npx`-run Prisma CLI for quickstart migrations (`prisma/migrate.config.mjs`), `wardby quickstart`/`doctor` commands.
- Terraform, `gcloud`, `kubectl`, Helm (for ESO) are required by the GKE guide scripts *(not verified in full)*.

## Code References

- `deploy/Dockerfile` — build, migration and runtime image stages
- `deploy/local/docker-compose.yml:2-19` — local Postgres 16
- `deploy/production/compose.yml`, `Caddyfile` — self-hosted production stack
- `deploy/gcp/*.tf` — Cloud Run, Cloud SQL, Secret Manager, load balancer, Cloud Armor
- `deploy/gke/*.tf`, `up.sh`, `eso-values.yaml`, `database-grants.sql` — GKE module and scripts
- `deploy/kind-coding/manifests/{base,overlays}/` — Kubernetes manifests and NetworkPolicies
- `src/providers/jobs/kubernetes*.ts`, `docker*.ts` — job launchers and isolation
- `src/core/db.ts`, `prisma/` — database layer
- `src/observability/`, `deploy/observability/` — metrics, Prometheus, Grafana
- `.github/workflows/` — CI/CD

## Architecture Documentation

- Swappable provider seams: LLM (`anthropic`, `bedrock`, `openai`), executor (`in-process`, `container`, `dbos`), jobs (`docker`, `kubernetes`, `fake`), VCS, review host, issue tracker, auth, datastore, memory, secrets, blob store, email.
- Cloud-agnostic core; reference deployments per target (`deploy/gcp`, `deploy/gke`, `deploy/aws` placeholder), all values parameterised, no committed environment-specific identity (CLAUDE.md "Deployment (deploy/)").
- Untrusted workers isolated by gVisor runtime class, default-deny networking, a single egress rule to the proxy, and a preflight canary.

## Historical Context (from thoughts/)

- `.claude/thoughts/investigations/2026-10-09-database-layer-postgres-coupling.md` — Postgres usage, migrations, event bus, deploy references
- `.claude/thoughts/investigations/2026-10-09-observability-metrics-logging-telemetry.md` — metrics, logging, network policies, entry points
- `.claude/thoughts/investigations/2026-10-09-mysql-adoption-blockers.md`, `2026-10-09-mysql-core-database-spec.md` — **proposals only, not implemented** (MySQL as a core database)
- `.claude/thoughts/investigations/2026-10-09-scrapable-metrics-spec.md` — proposal only, not implemented

## Open Questions

- The full per-run service catalog (versions and any entries beyond `postgres`, `redis`, `mysql`, plus `postgres-postgis` mentioned in docs) was not enumerated; image digests were seen only for `redis` and `mysql`.
- The email provider has only a types file; whether any implementation exists elsewhere was not checked.
- The exact tool versions the GKE scripts require (Terraform, gcloud, Helm, kubectl) were not verified.
- Whether `deploy/production` is deployed anywhere, and which of the reference targets FreshBooks actually runs, is not recorded in the repo.
- The Anchore and Trivy scan scope per image was not read in detail.
