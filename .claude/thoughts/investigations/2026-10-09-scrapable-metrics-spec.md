# Scrapable metrics for Datadog and other collectors — Spec

**Jira:** none (create a DEVXP story at ship time via the commit-and-pr flow)
**Created:** 2026-10-09
**Research:** `.claude/thoughts/investigations/2026-10-09-observability-metrics-logging-telemetry.md`
**Branch:** implement on a new branch off `main` (not `add-support-for-mysql`, which is parked).
**Visibility:** internal design doc. CLAUDE.md says specs and plans stay out of tracked paths; copies live in `.claude/thoughts/` and `docs/private/`. Operator-facing text produced by Phase 3 must follow "Public docs are for operators".

---

## Table of Contents

- [Overview](#overview)
- [Acceptance Criteria](#acceptance-criteria)
- [Dependencies](#dependencies)
- [Boundaries](#boundaries)
- [Design Decisions](#design-decisions)
- [Phase Summary](#phase-summary)
- [Monitoring](#monitoring)
- [Error Handling Matrix](#error-handling-matrix)
- [Resolved Questions](#resolved-questions)
- [Open Questions](#open-questions)
- [Definition of Done](#definition-of-done)
- [Appendix A: Datadog wiring (outside this repo)](#appendix-a-datadog-wiring-outside-this-repo)
- [Change Log](#change-log)

---

## Overview

Make wardby's metrics scrapable by any Prometheus-compatible collector (Datadog Agent OpenMetrics check, an OpenTelemetry Collector `prometheus` receiver, Prometheus itself) in the Kubernetes deployments, with **no new runtime dependency and no vendor-specific code**.

Today only the coding-proxy process serves `/metrics`, and in the default deployments nothing sets `METRICS_BIND`, exposes port 9464 or allows a scraper through the default-deny NetworkPolicies. The run-lifecycle metrics (`wardby_coding_*`: active jobs, terminal outcomes, cleanup failures, run duration, budget reserved/actual) are defined but never populated, because the executor that emits lifecycle events runs in the control-plane process and uses a Pino-only observer.

Customer impact: operators (and FreshBooks' own platform team) get run outcome, budget and cost metrics in the monitoring tool they already use, and the existing "Coding Jobs and Cleanup Failures" dashboard panel starts showing real data. Nothing changes for operators who do not enable metrics (off by default).

**In scope**
- Populate the `wardby_coding_*` metrics from the control-plane process (observer wiring + a metrics listener in `serve`, `mcp` and `scheduler`).
- Scope the metric registries per process so a process only registers the metrics it can drive.
- Kubernetes manifests: metrics container port, bind env, Prometheus-convention scrape annotations, and an opt-in NetworkPolicy component that allows only an operator-chosen scraper to reach the metrics port.
- Local Prometheus/Grafana overlay: scrape the control plane as well.
- Manifest tests that pin the security properties; unit tests for the metrics wiring.
- `docs/`, `help/`, README and OKF updates (CLAUDE.md docs+help check).

**Out of scope** (separate specs if wanted)
- OpenTelemetry SDK, traces, trace-id log correlation, OTLP export.
- New metrics for the MCP HTTP server (request counts/latency), scheduler, DB pool or viewer.
- Datadog-specific manifests, dashboards, monitors or SLOs; deploying a Datadog Agent or collector (infra team).
- Cloud Run (`deploy/gcp`, documented as deprecated) and `deploy/production` compose changes beyond documentation.
- Changing existing metric names or label sets.

---

## Acceptance Criteria

- [ ] **Off by default:** WHEN `METRICS_BIND` is unset in any process, the process SHALL NOT open a metrics listener (unchanged behaviour).
- [ ] **Control-plane endpoint:** WHEN `METRICS_BIND` is set for `wardby serve`, `wardby mcp` or `wardby scheduler`, the process SHALL serve `GET /metrics` (Prometheus exposition format) and `GET /healthz` on that address, with the same bind rules as the proxy (`127.0.0.1`, `::1`, or `0.0.0.0` only with `METRICS_ALLOW_NON_LOOPBACK=true`).
- [ ] **Lifecycle metrics populated:** WHEN a coding run is queued, launched, finishes (any terminal outcome) and is cleaned up, the control-plane `/metrics` SHALL show `wardby_coding_lifecycle_events_total{stage}` increments for each stage, `wardby_coding_runs_terminal_total{outcome}` for the outcome, `wardby_coding_active_jobs` returning to its prior value after cleanup, and `wardby_coding_run_duration_seconds` / budget counters updated.
- [ ] **No duplicate zero series:** WHEN the proxy and control plane are both scraped, each metric family SHALL be registered only by the process that can drive it (proxy: `wardby_proxy_*`; control plane: `wardby_coding_*`); both expose `wardby_nodejs_*`.
- [ ] **Existing names and labels unchanged:** WHEN dashboards or alerts written against the current metric names are used, they SHALL work without modification.
- [ ] **Telemetry cannot affect runs:** WHEN the metrics observer throws, the run's behaviour and terminal status SHALL be unchanged (existing `ContainerExecutor.emit` guarantee preserved).
- [ ] **Label safety:** WHEN metrics are scraped, no label value SHALL contain run ids, request ids, models, repositories, prompts, error text or credentials (only the finite enums already in use).
- [ ] **Network isolation:** WHEN the metrics NetworkPolicy component is applied, the metrics port (9464) on the proxy and control-plane pods SHALL be reachable only from pods matching the operator-supplied scraper selector, and SHALL NOT be reachable from `wardby.io/component=coding-run` pods; the worker run policy (egress to the proxy on 8787 only) SHALL be unchanged.
- [ ] **No new egress:** WHEN the manifests are rendered, no workload SHALL gain an egress rule as part of this change.
- [ ] **Docs and help:** WHEN an operator reads `docs/observability.md` and `help/observability.md`, they SHALL find the control-plane endpoint, ports, env vars, scrape annotations, the NetworkPolicy component and generic collector guidance; `search_help` SHALL return the article for "metrics", "prometheus" and "scrape".
- [ ] **Testing:** WHEN new code is added, existing coverage thresholds SHALL still pass.
- [ ] **No regression:** WHEN `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test` and `npm run build` run, all SHALL pass (database-gated tests run against Postgres as today).

---

## Dependencies

### Internal
| Component | Location | How reused |
|---|---|---|
| `WardbyMetrics`, `startMetricsServer`, `loadMetricsConfig` | `src/observability/` | extended (scoped registries) and reused in the control plane |
| `CodingRunObserver`, `codingRunObserver` | `src/coding/observability.ts:38,118` | composed with the Prometheus observer |
| `ContainerExecutor` observer option | `src/providers/executor/container.ts:517,605` | receives the composite observer |
| `buildConfiguredExecutor` | `src/providers/executor/composition.ts:49,141-175` | gains an `observer` option |
| Existing manifest tests | `deploy/kind-coding/manifests/overlays/gke-autopilot/*.test.mjs` | pattern for new manifest tests (Vitest, `loadAllYaml`) |
| Local stack | `deploy/observability/` | second scrape job |

### Environment variables
| Variable | Purpose | Source |
|---|---|---|
| `METRICS_BIND` | enable the metrics listener (existing) | manifest / operator |
| `METRICS_ALLOW_NON_LOOPBACK` | allow `0.0.0.0` bind (existing) | manifest / operator |

No new env vars are introduced.

### External
- A Prometheus-compatible scraper in the cluster, provided by the operator. This repo ships no collector. (FreshBooks: Datadog Agent, see Appendix A; wiring lives outside this repo.)
- No new npm dependency. No procurement ticket needed; Datadog is an existing vendor, but confirm custom-metric volume with the account owner before enabling (about 13 metric families with bounded labels per process).

---

## Boundaries

**ALWAYS**
- Keep metrics off unless `METRICS_BIND` is set; keep the bind validation rules.
- Keep label sets finite and metadata-only (CLAUDE.md-adjacent rules in `src/observability/metrics.ts:23-27` and `docs/observability.md`).
- Run `npm run typecheck && npm run lint && npm run format:check && npm test` before marking a phase done.
- Update `docs/`, `help/`, README and `.okf/` in the same change (Phase 3).

**ASK FIRST**
- Adding any NetworkPolicy rule beyond the opt-in scrape-ingress component, or any egress rule.
- Renaming a metric or changing its labels.
- Binding the metrics listener in the MCP server's own HTTP server instead of a separate listener.

**NEVER**
- Put vendor-specific (Datadog) annotations, namespaces or selectors in tracked manifests, docs or help; the repo's public docs stay vendor-neutral (CLAUDE.md "Public docs are for operators").
- Expose `/metrics` on the public MCP port, the Gateway, or the Cloud Run service.
- Add the scraper to the worker run NetworkPolicy or allow `coding-run` pods to reach port 9464.
- Commit real hostnames, project ids, namespaces of our infrastructure, or live-test output.

---

## Design Decisions

### Decision 1: Scrape existing Prometheus endpoints; no OTel SDK now
| Approach | Pros | Cons |
|---|---|---|
| **Make existing `/metrics` scrapable** | no new dependency; vendor-neutral; Datadog Agent OpenMetrics and OTel Collector both read it; preserves metric names | no traces; metrics only |
| Add OTel SDK + OTLP | traces, native OTLP | new dependency in the trusted proxy; span redaction work; Prisma 7 tracing unverified; much larger |

**Decision:** scrape. OTel stays a documented future option and is out of scope.

### Decision 2: Separate metrics listener in the control plane
Reuse `startMetricsServer(registry, bind)` on `METRICS_BIND`, started by `serve`, `mcp` and `scheduler`, closed in the existing shutdown order. **Rationale:** same security properties as the proxy (private listener, off by default, bind allow-list); the MCP HTTP server has no health route and is internet-facing, so `/metrics` must not share it. In stdio MCP mode the registry exists but no listener starts unless `METRICS_BIND` is set.

### Decision 3: Scope the registry by process
`createWardbyMetrics({ scope: "proxy" | "control-plane" })`: proxy scope registers `wardby_proxy_*` and default metrics; control-plane scope registers `wardby_coding_*` and default metrics. `WardbyMetrics` keeps its current public methods; the existing constructor behaviour (all families) stays available as scope `"all"` so current tests and the proxy path do not break. **Rationale:** avoids permanently-zero duplicate series from the "wrong" process while keeping names unchanged.

### Decision 4: Composite observer
Add `CompositeCodingRunObserver` in `src/coding/observability.ts` that forwards `emit` to each child inside its own try/catch. The control plane builds `[codingRunObserver (Pino+memory), controlPlaneMetrics]` and passes it as `observer` through `buildConfiguredExecutor`. **Rationale:** keeps the existing log line (`coding.<stage>`), adds Prometheus, preserves the "telemetry cannot change behaviour" guarantee.

### Decision 5: Port 9464 for every process, scraped by pod
Both the proxy and control-plane containers use `METRICS_BIND=0.0.0.0:9464` with `METRICS_ALLOW_NON_LOOPBACK=true` (different pods, so no conflict). In the local Compose stack the control plane runs on the host, so it uses 9465 there to avoid clashing with the container's published port.

### Decision 6: Opt-in NetworkPolicy component, generic selectors
Ship `deploy/kind-coding/manifests/components/metrics-scrape/` (kustomize Component) with a NetworkPolicy allowing ingress to the metrics port on proxy and control-plane pods from a namespace + pod selector that are placeholders the operator patches (`wardby-metrics-scraper-namespace`, `app.kubernetes.io/name: wardby-metrics-scraper`). Not included in any overlay by default. **Rationale:** the repo cannot know the operator's collector; default-deny stays intact unless the operator opts in. Prometheus-convention pod annotations (`prometheus.io/scrape`, `/port`, `/path`) are added to the Deployments because they are generic and harmless when unused.

### Decision 7: Manifest tests pin the security properties
New `deploy/kind-coding/manifests/overlays/gke-autopilot/metrics.test.mjs` (Vitest, same style as `executor.test.mjs`) asserts: metrics port declared on proxy and control plane; component policy ingress is port 9464 only and from the placeholder selector only; no `coding-run` selector anywhere in it; worker run policy builder output unchanged (reuse `kubernetes-isolation` tests); no egress rules in the component.

---

## Phase Summary

| Phase | Name | Goal | Plan | Status |
|---|---|---|---|---|
| 1 | Control-plane lifecycle metrics | Scoped registries, composite observer, metrics listener in `serve`/`mcp`/`scheduler`, tests | `.claude/thoughts/plans/2026-10-09-scrapable-metrics-phase-1-control-plane-lifecycle-metrics.md` | Not Started |
| 2 | Deploy scrape wiring | Ports/env/annotations on manifests, opt-in NetworkPolicy component, local Prometheus job, manifest tests | `.claude/thoughts/plans/2026-10-09-scrapable-metrics-phase-2-deploy-scrape-wiring.md` | Not Started |
| 3 | Docs and help | `docs/`, `help/`, README, OKF, dashboards note | `.claude/thoughts/plans/2026-10-09-scrapable-metrics-phase-3-docs-and-help.md` | Not Started |

**Ordering rationale:** the code (1) must emit the metrics before manifests (2) expose them and docs (3) describe the final behaviour.

---

## Monitoring

This work is the monitoring surface. After deployment (Appendix A) verify in the collector:
- `wardby_coding_lifecycle_events_total` increments after a real or fake coding run;
- `wardby_coding_active_jobs` returns to 0 when idle;
- `up` for both targets is 1.

Alert candidates (defined in the operator's tool, not in this repo): `increase(wardby_coding_cleanup_failures_total[15m]) > 0`; `wardby_coding_active_jobs` above the concurrency cap for >30 min; terminal `outcome="lost"` or `budget_exhausted` rate; proxy 5xx ratio.

---

## Error Handling Matrix

| Scenario | Detection | Response | User impact |
|---|---|---|---|
| `METRICS_BIND` invalid | `parseBind` | process fails at startup with the existing error text | clear config error |
| Metrics listener port in use | `listen` error | startup fails (as proxy today); components already started are closed | clear error; run `kubectl logs` |
| Observer throws | try/catch in composite and `ContainerExecutor.emit` | swallow; other observers still run | none |
| Scraper blocked by NetworkPolicy | scrape target `up == 0` | operator applies/patches the component | no metrics until fixed |
| Replica restarts | counters reset | `rate()`/`increase()` handle resets; gauge restarts at 0 | none |
| Multiple control-plane replicas | per-pod series | sum in queries; no cross-replica gauge | document |

---

## Resolved Questions

The user did not answer the scoping questions; these were **assumed from the recommendation** and are reversible before Phase 1 starts:

1. **~~Scope~~** — zero-code scrape of `/metrics` plus the lifecycle fix (Decision 1). OTel SDK out of scope.
2. **~~Lifecycle metrics fix~~** — included (Phase 1).
3. **~~Target~~** — GKE Autopilot overlay and the shared base manifests (so the kind overlay inherits the ports); Cloud Run and production compose are docs-only.
4. **~~Where Datadog wiring lives~~** — outside this repo (Appendix A is a private reference, not shipped).
5. **~~Ticket~~** — none yet; create a DEVXP story at ship time.
6. **~~Branch~~** — new branch off `main`.

## Open Questions

None blocking. Items to verify at implementation time, each with a stated fallback:
- Whether the cluster's Datadog Agent version supports the OpenMetrics v2 check config in Appendix A (verify against the version in use; fallback: the legacy `prometheus` check or an OTel Collector `prometheus` receiver).
- Autopilot restrictions on the operator's collector deployment (infra team; does not change this repo's manifests).

---

## Definition of Done

### Automated Verification
```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npx vitest run src/observability deploy/kind-coding
kubectl kustomize deploy/kind-coding/manifests/overlays/gke-autopilot > /dev/null
kubectl kustomize deploy/kind-coding/manifests/components/metrics-scrape > /dev/null
npm run build:help
```

### Acceptance Criteria Verification
All items in [Acceptance Criteria](#acceptance-criteria) verified.

### Integration Verification
- [ ] Local: `npm run observability:up`, run the control plane on the host with `METRICS_BIND=0.0.0.0:9465 METRICS_ALLOW_NON_LOOPBACK=true`, run a fake coding run; both Prometheus targets are `up` and the "Coding Jobs and Cleanup Failures" panel shows data.
- [ ] Rendered GKE overlay + component: only the scraper selector can reach 9464; the preflight enforcement canary (`docs/coding-worker-isolation.md` preflight) still passes on a test cluster.
- [ ] Metrics-off deployment behaves exactly as before.

---

## Appendix A: Datadog wiring (outside this repo)

Private reference for the platform team; not shipped in manifests or docs. **Unverified against the cluster's Agent version.**

Datadog Agent Autodiscovery annotations on the pod (OpenMetrics v2 check), for the `proxy` and `control-plane` containers:

```yaml
metadata:
  annotations:
    ad.datadoghq.com/proxy.checks: |
      {"openmetrics": {"init_config": {}, "instances": [{
        "openmetrics_endpoint": "http://%%host%%:9464/metrics",
        "metrics": ["wardby_.*"]
      }]}}
```

Notes: the metric-name prefix and namespace option interact (avoid a double `wardby.wardby_*` prefix; check how names arrive in Datadog before building monitors); metrics arrive as custom metrics, so check volume; the Agent needs the Phase 2 NetworkPolicy component with its namespace/pod selector patched to the Agent's; Autopilot compatibility of the Agent is the infra team's call.

---

## Change Log

### v1.0.0 (2026-10-09)
**Changes:** initial spec from the observability investigation; defaults assumed where the user did not answer scoping questions.
**Author:** Claude (Sonnet 5.5) for fbrodrigorezino
