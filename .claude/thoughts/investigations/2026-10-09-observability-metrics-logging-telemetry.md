---
date: 2026-10-09T18:23:12+0000
researcher: Claude (Sonnet 5.5) for fbrodrigorezino
git_commit: f6f7f2a3457bf280bc56f954146068366344ecad
branch: add-support-for-mysql
repository: wardby
topic: "Observability today: Prometheus/Grafana usage, metrics, logging, network egress and I/O touchpoints (context for OpenTelemetry and Datadog)"
tags: [research, codebase, observability, prometheus, grafana, metrics, logging, pino, networkpolicy, egress, telemetry]
status: complete
last_updated: 2026-10-09
last_updated_by: Claude (Sonnet 5.5)
---

# Research: Observability today

**Date**: 2026-10-09T18:23:12+0000
**Researcher**: Claude (Sonnet 5.5)
**Git Commit**: f6f7f2a (code identical to 5f68c9e; only `.claude/thoughts/` files were added since)
**Branch**: add-support-for-mysql
**Repository**: wardby

## Research Question

Where are Prometheus and Grafana used in wardby today (metrics produced, endpoints, deploy wiring, dashboards, logging), how are the run-lifecycle metrics wired, and what exists today that is relevant to adopting OpenTelemetry and Datadog (egress/network policy, log output, instrumentation points, Prisma/pg/HTTP touchpoints)?

## Summary

- Prometheus metrics exist **only in the coding-proxy process** (`src/coding-proxy/main.ts`). They are served at `/metrics` on a separate private listener that is **off unless `METRICS_BIND` is set**. Metrics come from two proxy hooks (audit events and per-request timing) plus Node.js default process metrics.
- 13 metrics are defined; 6 are `wardby_coding_*` run-lifecycle metrics. `WardbyMetrics.emit()` (which drives them) has **no caller outside tests**. The executor that emits lifecycle events runs in the control-plane process and uses a Pino + in-memory observer, not Prometheus.
- Prometheus and Grafana are provisioned **only in a local Docker Compose overlay** (`deploy/observability`). No Kubernetes manifest, Terraform module or production compose file sets `METRICS_BIND`, exposes port 9464, or runs a collector. Docs say operators bring their own collector.
- Logging is one `pino` instance writing JSON to **stderr** (fd 2, async). `runId` is the main correlation key (also the DBOS `workflowID`); `diagnosticId` links failed coding runs to log lines. There is no `traceparent`/`x-request-id` handling, no `AsyncLocalStorage`, no tracing library, no OpenTelemetry or Datadog reference anywhere.
- On Kubernetes, a namespace-wide default-deny NetworkPolicy plus per-workload allow policies governs traffic. The control plane and coding proxy have 443 egress to non-private addresses; coding workers can reach only the proxy on 8787. No policy allows ingress to the proxy's metrics port or egress to a collector.

## Detailed Findings

### 1. Prometheus metrics (`src/observability/`)

- Library: `@prometheus-io/client` `^0.16.1` (`package.json:103`). `WardbyMetrics implements CodingRunObserver` (`metrics.ts:28`); default Node metrics via `collectDefaultMetrics({prefix:"wardby_nodejs_"})` (`metrics.ts:47`).
- Metrics (definition lines in `metrics.ts`):

| Metric | Type | Labels | Buckets | Line |
|---|---|---|---|---|
| `wardby_coding_lifecycle_events_total` | Counter | `stage` | | 49 |
| `wardby_coding_runs_terminal_total` | Counter | `outcome` | | 55 |
| `wardby_coding_active_jobs` | Gauge | | | 61 |
| `wardby_coding_cleanup_failures_total` | Counter | | | 66 |
| `wardby_coding_budget_reserved_usd_total` | Counter | | | 71 |
| `wardby_coding_budget_actual_usd_total` | Counter | | | 76 |
| `wardby_coding_run_duration_seconds` | Histogram | | 1,10,30,60,300,900,1800,3600 | 81-86 |
| `wardby_proxy_audit_events_total` | Counter | `event` | | 87 |
| `wardby_proxy_http_requests_total` | Counter | `protocol`,`status_class` | | 93 |
| `wardby_proxy_http_request_duration_seconds` | Histogram | `protocol`,`status_class` | 0.01,0.05,0.1,0.5,1,5,15,60,300 | 99-105 |
| `wardby_proxy_budget_reserved_usd_total` | Counter | | | 106 |
| `wardby_proxy_cost_usd_total` | Counter | | | 111 |
| `wardby_proxy_tokens_total` | Counter | `kind` (input, output, cached_input, cache_write, reasoning) | | 116 |

- Label design: finite enums only; the header comment (`metrics.ts:23-27`) says run ids, request ids, models, reasons, credentials and untrusted input never enter the registry. `protocol` is `openai-responses|anthropic-messages|other`; `status_class` is `1xx..5xx|other` (`metrics.ts:6,14-21`). Proxy audit `event` values: `session.created`, `session.cancelled`, `request.reserved`, `request.rejected`, `request.released`, `request.uncertain`, `response.completed` (`providers/coding-proxy/types.ts:119-126`).
- `emit(event)` (`metrics.ts:124-139`) handles lifecycle events (launched/cleanup/terminal, budgets, duration); `observeProxyAudit` (`:141-151`) and `observeProxyRequest` (`:153-157`) handle the proxy hooks.
- Endpoint: `startMetricsServer` (`metrics-server.ts:15-62`), plain `node:http`: `GET /healthz` → `ok`, `GET /metrics` → `registry.metrics()`, anything else 404 (exact URL match, so a query string yields 404). Timeouts 10 s request/header, 5 s keep-alive.
- Config: `loadMetricsConfig` (`config.ts:23-26`). `METRICS_BIND` must match `127.0.0.1|::1|0.0.0.0:port`; `0.0.0.0` needs `METRICS_ALLOW_NON_LOOPBACK=true` (exact string). Unset means metrics are off.

### 2. Where metrics are wired

- Only `src/coding-proxy/main.ts` constructs `WardbyMetrics` (`:29`): `audit` → `metrics.observeProxyAudit` + `logProxyAudit` (`:34-37`); `onRequest` → `metrics.observeProxyRequest` (`:38`); metrics server started only when `METRICS_BIND` set (`:41-43`); shutdown closes metrics server, proxy server, both Prisma clients (`:52-67`).
- `onRequest` is emitted from `providers/coding-proxy/server.ts:151-160` on response `finish` with `performance.now()` duration (the only `performance.now()` use in `src`).
- Lifecycle path (separate): `ContainerExecutor` emits `CodingLifecycleEvent` (11 stages, `coding/observability.ts:8-36`) via `this.observer.emit` (`container.ts:1471-1477`, errors swallowed: "Telemetry cannot change a run's security or terminal behavior"). The observer defaults to the module singleton `codingRunObserver = new PinoCodingRunObserver()` (`observability.ts:118`; `container.ts:605`). `composition.ts:141-175` builds `ContainerExecutor` without an `observer` option; it is called from `mcp/index.ts:199`, `cli.ts:702`, `cli.ts:793` (control-plane/CLI process).
- `PinoCodingRunObserver.emit` updates an in-memory `CodingMetrics` aggregate and logs `{event: "coding.<stage>", ...event}` at info (`observability.ts:104-115`). `InMemoryCodingRunObserver` is used only by tests.
- `WardbyMetrics.emit()` has no non-test caller. In the proxy process, the `wardby_coding_*` series are registered but not driven; the `coding-proxy` process does not import the executor or `coding/observability.ts`.
- `docs/coding-worker-isolation.md:529-538` describes lifecycle events as log events retained "by the production log/metrics collector ... 90 days by default policy", without naming a collector.

### 3. Prometheus and Grafana deployment (`deploy/observability`, `deploy/local`)

- `prometheus.yml`: 5 s scrape/evaluation, one job `wardby-coding-proxy` → `coding-proxy:9464` (default `/metrics`).
- `docker-compose.grafana.yml` (overlay on `deploy/local` compose files): `migration` service; `coding-proxy` gets `METRICS_BIND=0.0.0.0:9464` + `METRICS_ALLOW_NON_LOOPBACK=true` (`:16-17`); `prometheus` `prom/prometheus:v3.5.0`, 24 h retention, `127.0.0.1:9090`; `grafana` `grafana/grafana:12.0.0`, admin user `admin` with a local-only password, `127.0.0.1:3000`; volumes `wardby-prometheus-data`, `wardby-grafana-data`.
- Base `deploy/local/docker-compose.phase5.yml:1-24` defines `coding-proxy` (`node dist/coding-proxy/main.js`, read-only, tmpfs `/tmp`, `cap_drop ALL`, no published ports, no `METRICS_BIND`).
- Grafana provisioning: datasource `Prometheus` (uid `prometheus`, `http://prometheus:9090`, not editable); dashboard provider folder `Wardby` (file, non-deletable, non-editable).
- Dashboards (refresh 5 s):
  - `wardby-coding-proxy` "Wardby Coding Proxy": Proxy Requests by Status Class (`rate(wardby_proxy_http_requests_total[5m])`), Proxy p95 Request Duration (`histogram_quantile` over `wardby_proxy_http_request_duration_seconds_bucket`), Proxy Audit Events, Coding Jobs and Cleanup Failures (`wardby_coding_active_jobs`, `increase(wardby_coding_cleanup_failures_total[5m])`), Proxy Cost (`increase(wardby_proxy_cost_usd_total[24h])`), Proxy Resident Memory (`wardby_nodejs_process_resident_memory_bytes`).
  - `wardby-coding-budget` "Coding runs: Budget & Spend": Runs Created (24h) (`wardby_proxy_audit_events_total{event="session.created"}`), Reserved Budget (24h), Actual Spend (24h), Actual/Reserved ratio, Reserved vs Actual timeseries, Runs and Completed Requests timeseries; panels use `or vector(0)`.
- Scripts: `observability:up|smoke|down` (`package.json:76-78`); `scripts/grafana-smoke.mjs` checks Grafana health, Prometheus `up{job="wardby-coding-proxy"}`=1 and both dashboards by uid; no model request, no specific metric names.
- `METRICS_BIND` / port 9464 appear nowhere else in `deploy/`: not in `deploy/kind-coding/manifests` (`base/proxy.yaml` declares containerPorts 8787 and 8788 only), `deploy/gke`, `deploy/gcp`, `deploy/production`, or any `up.sh`.
- Operator docs: `docs/observability.md` (private-network `/metrics`, local stack, AWS CloudWatch Agent and GCP Ops Agent collector pointers, "reference cloud deployments do not provision these collectors", "Application/MCP coverage is still narrower than the coding-proxy coverage"); `help/observability.md` (id `observability`, appliesTo `>=0.2.1`); `README.md:271-295` "Bring your own observability"; `docs/architecture-runtime.md:6,36-58` (proxy `:9464/metrics (private net only)`, Prometheus/Grafana on loopback); `.okf/architecture/coding-proxy.md:18`.

### 4. Logging

- `src/core/logger.ts`: one `pino` instance; destination `pino.destination({fd:2, sync:false})` (`:48`) — stderr, async, because stdout is the stdio-MCP JSON-RPC wire; level `LOG_LEVEL` (default `info`, `:47`, read only here and not set by any deploy file); no `base`, `formatters`, `timestamp` or pino `redact` options (pino defaults `pid`, `hostname`, `time`); one custom `err` serializer (`redactErr` → `redactDeep` → `redactAndTruncate`, 16 KiB cap, depth 4; `:22-44`).
- Redaction primitives in `src/coding/protocol.ts:542-583` (`redactTokenShapedValues`, `redactAndTruncate`); non-`err` fields are not redacted by the logger. Other redaction layers: worker debug trace (`coding-worker/debug-trace.ts`, stdout of the worker pod, 2 MiB cap per run), sandbox console (`sandbox/host-functions.ts:94-101`, `redactPii`).
- ~60 module-scoped children via `logger.child({module})` (e.g. `coding-proxy-runtime`, `mcp-index`, `cli`, `streamable-http`, `container-executor`, `dbos-executor`, `scheduler`, `coding-proxy-ledger`); per-invocation child in `sandbox/host-functions.ts:73-77` (`agentId`, `tool`).
- Event-name convention: dotted lowercase `event:` field plus message (e.g. `proxy.started`, `metrics.started`, `proxy.stopping`, `proxy.shutdown_failed`, `request.rejected`, `request.failed`, `metrics.observe_failed`, `audit.<type>`, `coding.<stage>`, `coding.provider_failure`, `coding.debug_trace.set`, `models.catalog.*`, `registry.unavailable`, `registry.failed`). Many lines have no `event:` and use message + fields (e.g. `runner.ts:471`, `runner.ts:1006`, `issue-events.ts:189`, `jira-ingress.ts:98`).
- Proxy audit log: `logProxyAudit` (`providers/coding-proxy/server.ts:20-23`) logs `{...fields, event:"audit.<type>"}` at info; fields (`types.ts:118-142`): `runId`, `requestId?`, `model?`, `status?`, `reason?`, `reservationUsd?`, `costUsd?`, token counts, `contentType?`, `contentEncoding?`. `session.cancelled` has no emission site in non-test code (`proxy.ts:1246` calls `ledger.cancelSession` without `audit`).
- Correlation identifiers:
  - `runId` (= `Run.id`): in lifecycle events, every proxy audit event, runner/dispatch logs, worker debug-trace lines, DB keys; it is also the DBOS `workflowID` (`providers/executor/dbos.ts:181`).
  - `diagnosticId` (`coding_diag_<uuid>`, `container.ts:1512`): logged with failure category, persisted in `CodingRun.diagnosticId` (`prisma/schema.prisma:458`) and the run error (`coding_failure_<category>:<id>`), returned by `get_run` (`mcp/tools/runs.ts:75-111`).
  - MCP HTTP 500: `requestId = randomUUID()` logged as `HTTP request failed` and returned as `{error:"internal_error", id}` (`streamable-http.ts:97-99`) — the only per-request id minted in the server. The proxy's `internal_error` 500 returns no id (`server.ts:301`).
  - Proxy ledger `requestId`; `Idempotency-Key` header as ledger `requestKey` (`server.ts:261`); `x-github-request-id` included in GitHub API error text (`providers/vcs/github.ts:163-164`); `x-client-request-id` is commented as a tracing identifier not used as the idempotency key (`server.ts:260`).
  - Not present: `traceparent`, `x-request-id`/correlation header handling.
- Log collection in deploy files: none. No docker `logging:` driver, no Cloud Run log settings, no Cloud Logging sinks, no `LOG_LEVEL`. The only log-related deploy setting is `--structured-logs` on the Cloud SQL Auth Proxy sidecar (`control-plane.yaml:129`, `proxy-cloudsql.yaml:31`, `deploy/gke/bootstrap-grants-job.yaml:46`). Docs: worker debug-trace logs are the run pod's `worker` container log, kept by Cloud Logging on GKE (`docs/coding-worker-isolation.md:238-240`); a "production log/metrics collector" is referenced but not named (`:536`).
- "Never log" rules live in code comments and docs rather than `CLAUDE.md`/`CLEANROOM.md`: lifecycle events are metadata-only (`observability.ts:3-7`), audit events carry ids/models/amounts/statuses/reason codes only (`server.ts:15-19`), `diagnosticId`/`failureCategory` may not contain task, repository, environment or credential data (`schema.prisma:455-456`), upstream rejection bodies are never relayed (`proxy.ts:1156`), lifecycle events never carry prompts/diffs/credentials (`docs/coding-worker-isolation.md:529-534`).

### 5. Processes, entry points and lifecycle

- `bin/wardby.js` → `dist/wardby-bin.js` (offline commands: `--help`, `--version`, `quickstart`, `doctor`, `status`, `logs`, `down`, `help`, `knowledge`) else `dist/cli.js` (`import "./env.js"` first).
- Long-running commands in `src/cli.ts`: `serve` (`serve.ts:42-93`: MCP HTTP + reconciler + scheduler in one process), `mcp` (MCP only), `scheduler` (scheduler + reconciler + executor launch + coding-queue drain; does not call `waitForInFlightRuns`). Docker images: `deploy/Dockerfile` stages `build`, `migration` (`npm run prisma:migrate`), `runtime` (`node dist/cli.js serve`, `USER node`); worker images `src/coding-worker/Dockerfile*`, `src/claude-coding-worker/Dockerfile`, `src/claude-tool-runner/Dockerfile`.
- Other entry points: `src/coding-proxy/main.js` (two Prisma clients: ledger pool via `CODING_PROXY_DB_POOL_MAX` default 5, registry pool `REGISTRY_DB_POOL_MAX` default 3); worker mains (`coding-worker/main.ts`, `claude-coding-worker/main.ts`: JSON progress lines on stdout, errors as JSON on stderr, exit 143 if aborted else 1); `keeper.ts` (idles on a 60 s interval); `claude-tool-runner/main.mjs` (UNIX socket MCP server).
- Background loops: scheduler lease + tick (10 s each, `core/timing.ts:3-8`), reconciler (15 s), model catalog poll, hourly auth cleanup (`mcp/index.ts:422`), 15-min OAuth cleanup, SSE ping 15 s, viewer bus health check 60 s, heartbeats 10 s (`core/run-heartbeat.ts:34`, `dbos.ts:292`, `in-process.ts:29`).
- Shutdown: signal handlers via `process.once` (`cli.ts:827-828,850-851,869-870`, `coding-proxy/main.ts:66-67`, worker mains, `keeper.ts`); `SHUTDOWN_DRAIN_SECONDS` (default 600; `config/providers.ts:287-295`) applies only to the MCP HTTP close path (`mcp/index.ts:427-436`: clear timer → `http.close()` → viewer bus → `waitForInFlightRuns` → `executor.close()` → catalog close); coding jobs are not counted in in-flight tracking (`core/in-flight-runs.ts:3-6`). No `uncaughtException`, `unhandledRejection`, `beforeExit` or `exit` handlers exist in non-test `src`.
- Config: `src/env.ts` is the single dotenv-flow load point (`<projectDir>/.wardby` then `<projectDir>`; never overwrites existing env); typed loaders in `src/config/providers.ts` and `src/observability/config.ts` take an `env` argument defaulting to `process.env`. Worker mains do not import `env.ts`.

### 6. Inbound and outbound I/O touchpoints

- **MCP HTTP server** (`mcp/transport/streamable-http.ts`): one `route()` (`:103-241`) with Host/Origin validation, body-size limits and routes `/.well-known/oauth-protected-resource`, secret-elicitation path, self-hosted OAuth endpoints (`/register`, `/authorize`, `/login`, `/consent`, `/logout`, `/token`, `/revoke`, `/.well-known/oauth-authorization-server`), `POST /webhooks/:id`, `POST /hosts/github/events`, `POST /hosts/jira/events`, `GET /hosts/github/user-callback`, `/admin/api/*` (viewer), `/mcp`. No health/readiness route on this server.
- **Viewer** (`viewer/http.ts`): `/admin/api/graph`, `/events` (SSE), `/infra`, `/runs/:id`; scope `admin:view`; created only when `DATABASE_URL` is set. No separate viewer process or port.
- **Coding proxy** (`providers/coding-proxy/server.ts`, `runtime.ts:72-135`): listens `0.0.0.0` on 8787 (proxy+registry) and 8788 (deny port, closes connections); routes `/registry/<eco>/*` (GET/HEAD, `-/plan` POST), `POST /v1/responses`, `POST /v1/messages`, `HEAD /api/hello`; `requireHostHeader:true`, `expectedHost = wardby-proxy:8787`.
- **Outbound HTTP**:
  - Global undici 8 `Agent({allowH2:false})` installed once by `core/http-runtime.ts:85-102` (imported by `env.ts:11`); used by built-in `fetch` in Jira (`jira-client.ts:36`), GitHub (`providers/vcs/github.ts:545`, choke points `requestJson` `:1036-1062` and `graphql` `:1068`), GitHub user auth, jose JWKS, and the LLM SDKs (`providers/llm/openai.ts`, `anthropic.ts`, `bedrock.ts`; none passes a custom fetch/dispatcher). `@kubernetes/client-node` also loads undici 8.
  - Raw `node:http(s)` with `agent:false` and pinned DNS: `sandbox/safe-fetch.ts`, `sandbox/fetch-policy.ts`, `providers/coding-proxy/secure-fetch.ts` (`createPinnedProxyFetch`: https only, no IP hosts, no redirects, string bodies). Upstream model URLs `https://api.openai.com/v1/responses` and `https://api.anthropic.com/v1/messages?beta=true` (`proxy.ts:930-931`); registry/OSV hosts `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `api.osv.dev` (`runtime.ts:79-82`).
  - Subprocess I/O (`child_process`): `providers/vcs/git.ts`, `providers/jobs/docker.ts`, `providers/jobs/kubernetes.ts`, `cli.ts`, `quickstart/*`, worker shims.
- **Database**: `core/db.ts` singleton `prisma` over `@prisma/adapter-pg` (pool `max` default `availableParallelism()*2+1`, 10 s connection timeout). No `$extends`, `$on`, `$use` or `log` option anywhere (`new PrismaClient({adapter})`, `db.ts:84`). `pg` used directly only for `viewer/event-bus.ts` (`pg.Client` LISTEN). DBOS opens its own system-database connection with `runAdminServer:false`, `logLevel:"warn"` and no tracing options (`dbos.ts:141-148`).
- **Existing timing/context helpers**: no `AsyncLocalStorage`, `perf_hooks`, `diagnostics_channel` or `process.hrtime`; `Date.now()` deltas for `durationMs` in delegation logs (`core/runner.ts:1005-1084`) and coding run duration (`container.ts:1530-1533`).
- **Tracing vocabulary**: none for distributed tracing. "span" in `src` means knowledge-bundle cited spans (`knowledge/span-hash.ts`); "trace" means the coding-worker debug trace (`coding-worker/debug-trace.ts`, `mcp/tools/agents.ts:616` `debugTraceMinutes`).

### 7. Network topology relevant to telemetry traffic

Kubernetes (kind and GKE Autopilot), namespace `wardby-coding`, manifests under `deploy/kind-coding/manifests`:
- `base/default-deny.yaml:9-13` — `podSelector:{}`, Ingress+Egress, no rules.
- Coding proxy (`base/proxy.yaml`): ClusterIP ports 8787 and 8788; ingress only from pods labelled `wardby.io/component=coding-run` on both ports (`:107-132`); egress: DNS to kube-dns on 53 and TCP 443 to `0.0.0.0/0` except 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10 (`:135-161`). GKE overlay adds `proxy-dns-egress.yaml` (node-local DNS 169.254.20.10, 169.254.169.254, kube-dns on 53) and `proxy-database-egress.yaml` (DB CIDR TCP 3307; metadata 169.254.169.254/32 and 169.254.169.252/32 on 80 and 988). The kind overlay allows `0.0.0.0/0` on TCP 55432 for local Postgres.
- Control plane (`overlays/gke-autopilot/control-plane.yaml`): one container `node dist/cli.js serve` on 8080 plus a Cloud SQL Auth Proxy native sidecar (listens 127.0.0.1:5432 and 0.0.0.0:9090 health). NetworkPolicy `wardby-control-plane` (`:418-506`): no ingress; egress to DNS (169.254.20.10, 169.254.169.254, kube-dns on 53), DB CIDR TCP 3307, metadata servers, and non-private TCP 443 (Kubernetes API endpoint, GitHub, Atlassian, other HTTPS). Gateway `control-plane-gateway.yaml`: GKE L7 external managed Gateway on 443 (80 redirects), Cloud Armor policy, `timeoutSec: 3600`, a `wardby-control-plane-lb` NetworkPolicy allowing ingress to 8080 from 130.211.0.0/22 and 35.191.0.0/16.
- Coding worker pods: per-run NetworkPolicy with `ingress: []` and exactly one egress rule to pods `app.kubernetes.io/name=wardby-coding-proxy` on TCP 8787 (`providers/jobs/kubernetes-isolation.ts:514-532`); `dnsPolicy: None` with nameserver `127.0.0.1` and a `hostAliases` entry for `wardby-proxy`; no ports; no DB, DNS, internet or metadata access.
- Migrate Job (`overlays/gke-autopilot/migrate/`): own NetworkPolicy (DNS, DB 3307, metadata, non-private 443, no ingress); applied by `deploy/gke/up.sh`, not via the overlay kustomization.
- Secrets: `overlays/gke-autopilot/secrets/` contains `store.yaml` (ServiceAccount `wardby-secrets-reader` and SecretStore `gcp-secret-manager`), `external-secrets.yaml` (ExternalSecrets `wardby-coding-proxy-env` and `wardby-control-plane-env`), `external-secrets-jira.yaml`, `canary.yaml`, each with `refreshInterval: 1h`; it has its own `kustomization.yaml` and is not listed in the overlay's `resources`. ESO itself is installed by Helm with `deploy/gke/eso-values.yaml` (namespace-scoped); the repo has no NetworkPolicy for it. (An investigation agent reported this directory as missing; verified present by direct listing.)
- No manifest or policy in the repo allows traffic to a collector or agent, and no pod runs one.

Other targets: `deploy/production/compose.yml` (services `edge` Caddy 80/443 publishing, `mcp` 8080 `expose` only, `scheduler`, `migrate`; two bridge networks `edge` and `service`; no egress restrictions; no database service; no logging driver); `deploy/gcp` Cloud Run (port 8080 default, ingress internal-LB-only when Cloud Armor is enabled, no VPC access/egress settings in Terraform, Cloud SQL via `/cloudsql` volume, no sidecars; documented as the deprecated reference in `deploy/gke/README.md:24-30`); `deploy/local` compose (Postgres 55432).

## Code References

- `src/observability/metrics.ts:28-157` — `WardbyMetrics`, all metric definitions and handlers
- `src/observability/metrics-server.ts:15-62` — `/metrics` and `/healthz` listener
- `src/observability/config.ts:23-26` — `METRICS_BIND` parsing
- `src/coding-proxy/main.ts:28-74` — proxy startup, metrics wiring, shutdown
- `src/providers/coding-proxy/server.ts:151-160,20-23` — per-request timing hook, audit log sink
- `src/coding/observability.ts:8-129` — lifecycle events, `CodingMetrics`, `PinoCodingRunObserver`, `codingRunObserver`
- `src/providers/executor/container.ts:605,1471-1477` — observer default and emit
- `src/providers/executor/composition.ts:141-175` — executor built without an observer option
- `src/core/logger.ts:22-51` — pino configuration and `err` redaction
- `src/core/http-runtime.ts:85-102` — global undici dispatcher
- `src/core/db.ts:73-87` — Prisma client creation (no hooks)
- `src/mcp/transport/streamable-http.ts:75-266` — MCP HTTP routes, request id on 500
- `deploy/observability/prometheus.yml`, `docker-compose.grafana.yml:16-17`, `grafana/dashboards/*.json` — local Prometheus/Grafana
- `deploy/kind-coding/manifests/base/default-deny.yaml`, `base/proxy.yaml:95-161`, `overlays/gke-autopilot/control-plane.yaml:418-506` — NetworkPolicies
- `src/providers/jobs/kubernetes-isolation.ts:514-532` — per-run worker NetworkPolicy
- `docs/observability.md`, `help/observability.md`, `README.md:271-295` — operator docs

## Architecture Documentation

- Two telemetry paths exist independently: (a) a pull-based Prometheus registry in the coding-proxy process fed by proxy audit/request hooks; (b) Pino logs plus an in-process aggregate in the control-plane process fed by executor lifecycle events. They share the vocabulary of `CodingLifecycleEvent` and `ProxyAuditEvent` but run in different processes.
- Observation seams that already exist as interfaces: `CodingRunObserver.emit` (executor option `observer?`), proxy `audit` sink and `onRequest` callback (`startConfiguredCodingProxy` options).
- Telemetry failures are intentionally isolated from behaviour (swallowed in `ContainerExecutor.emit`; caught and logged as `metrics.observe_failed` in the proxy).
- Security posture shapes telemetry: bounded label sets, metadata-only events, redacting `err` serializer, private-only metrics listener, default-deny network policies with a single egress rule for workers.
- One process-wide HTTP dispatcher is installed for built-in `fetch`; sandbox and proxy egress use pinned-DNS raw `node:http(s)` clients outside it.
- Operator-facing docs describe Prometheus-compatible scraping and defer collector choice to operators; no vendor-specific telemetry is referenced anywhere in tracked code, docs or deploy files.

## Historical Context (from thoughts/)

- `.claude/thoughts/investigations/2026-10-09-database-layer-postgres-coupling.md` — earlier investigation (DB layer); mentions the viewer event bus and Prometheus-unrelated areas only.
- `.claude/thoughts/investigations/2026-10-09-mysql-*.md`, `.claude/thoughts/plans/2026-10-09-mysql-phase-*.md` — MySQL spec/plans; they touch observability only incidentally (log fields and startup checks).
- No prior document addresses OpenTelemetry, Datadog, tracing or collector deployment.

## Open Questions

- Whether `wardby_coding_*` lifecycle series export as 0/absent from a running proxy was not confirmed by running the code (inferred from code and the Prometheus client's behaviour).
- `deploy/kind-coding/README.md` and `up.sh` were grepped but not read in full for network details; `launcher-role.yaml`, `priority.yaml`, `proxy-priority.yaml`, `proxy-resources.yaml` were not read in full (they contain no network policy).
- The GitHub clone/pull-request code path that uses the control plane's 443 egress was not traced; the host is taken from the manifest comment.
- Which "production log/metrics collector" `docs/coding-worker-isolation.md:536` refers to is not specified in the repo.
- Cloud Run egress defaults: no VPC/egress settings exist in Terraform, so effective egress is the platform default (not inspected live).
- How the Prisma 7 client and `@prisma/adapter-pg` behave with external instrumentation was not examined (no hooks exist in the repo).
