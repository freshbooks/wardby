# Scrapable metrics Phase 3: Docs and help

**Spec:** `.claude/thoughts/investigations/2026-10-09-scrapable-metrics-spec.md`
**Jira:** none yet
**Depends on:** Phases 1 and 2 complete (documents final, verified behaviour)

---

## Table of Contents

- [Overview](#overview)
- [Current State Analysis](#current-state-analysis)
- [Changes Required](#changes-required)
- [Success Criteria](#success-criteria)
- [References](#references)

---

## Overview

CLAUDE.md requires every operator-visible change to be evaluated for `docs/` and `help/`, and public docs must be generic operator guidance: no test-run narrative, no our-infrastructure details, no vendor-specific wiring beyond what the existing docs already do (they name collector products as examples). This phase documents the control-plane endpoint, ports, annotations, the opt-in NetworkPolicy component and generic scraper guidance.

## Current State Analysis

- `docs/observability.md`: proxy-only `/metrics`, local Prometheus/Grafana, AWS CloudWatch Agent and GCP Ops Agent collector pointers, "Application/MCP coverage is still narrower than the coding-proxy coverage", production checklist.
- `help/observability.md` (id `observability`, tags observability, prometheus, grafana, metrics, operations, `appliesTo >=0.2.1`): condensed version; served by `search_help`, bundled by `npm run build:help`.
- `README.md:271-295` "Bring your own observability"; `docs/architecture-runtime.md:6,36-58` (proxy `:9464/metrics (private net only)`, Prometheus/Grafana on loopback); `docs/coding-worker-isolation.md:529-538` (lifecycle events as logs, "production log/metrics collector" unnamed); `docs/getting-started-gke.md`, `deploy/README.md`, `.okf/architecture/coding-proxy.md:18`.
- Public-doc rules: CLAUDE.md "Public docs are for operators" and "Every feature gets a docs + help check".

### Key Discoveries
- The proxy's `wardby_coding_*` series disappear from proxy scrapes (Phase 1); docs must say which process exposes which family.
- `help/` frontmatter requires `id`, `title`, `summary`, `audience`, `tags`, `appliesTo`; error articles go under `help/errors/` (none needed here: no new error code).

## Changes Required

- [ ] **Main guide** (`docs/observability.md`)
  - Verify: `npx prettier --check docs/observability.md`
  - Files: that file
  Add: which process serves which metric family (proxy: `wardby_proxy_*`; control plane: `wardby_coding_*`; both: `wardby_nodejs_*`); how to enable (`METRICS_BIND`, `METRICS_ALLOW_NON_LOOPBACK`, ports 9464 in cluster / 9465 in the local-host workflow); the Prometheus-convention pod annotations; the opt-in NetworkPolicy component and how to patch its two placeholders; generic collector guidance covering "any Prometheus-compatible scraper, for example a Prometheus server, the Datadog Agent's OpenMetrics check, or an OpenTelemetry Collector `prometheus` receiver"; multiple replicas (per-pod series, sum in queries, counters reset on restart); label safety statement; update the "narrower coverage" sentence to state the current coverage precisely. Operator voice only; placeholders (`your-namespace`), no FreshBooks specifics.

- [ ] **Help article** (`help/observability.md`)
  - Verify: `npm run build:help` and a `search_help` check for "metrics", "prometheus", "scrape", "METRICS_BIND", "datadog"
  - Files: that file (+ `help/deployment-targets.md` link if it lists observability)
  Mirror the guide's essentials in short form; bump `appliesTo` to the release that ships this; keep tags; add tags `scrape`, `networkpolicy`. Confirm each query returns this article first using the repo's help search test or a short `tsx` script over `dist/help-index.json`.

- [ ] **Architecture and isolation docs** (`docs/architecture-runtime.md`, `docs/coding-worker-isolation.md`)
  - Verify: `npx prettier --check docs`
  - Files: those two
  Architecture diagram/labels: control plane `:9464/metrics (private net only)` alongside the proxy; state that scraper ingress is opt-in. Isolation doc `:529-538`: state that lifecycle events are both logged (`coding.<stage>`) and counted in the control plane's metrics, and that workers cannot reach the metrics port.

- [ ] **README and deploy docs** (`README.md`, `deploy/README.md`, `docs/getting-started-gke.md`, `deploy/kind-coding/manifests/components/metrics-scrape/README.md`)
  - Verify: `npx prettier --check README.md deploy docs`
  - Files: those four
  README "Bring your own observability" (`:271-295`) points to the guide and mentions both processes; GKE guide gets a short "enable metrics" subsection (annotations + component) with placeholders; the component README (Phase 2) is checked for the same operator voice.

- [ ] **OKF bundle** (`.okf/architecture/coding-proxy.md`, `.okf/architecture/runner-and-engine.md`, `.okf/index.md` only if links change)
  - Verify: `/okf:validate .okf --strict`
  - Files: those (follow the `okf:okf` skill)
  Update the proxy concept (`/metrics` on 9464 is proxy families only) and add the control-plane metrics and composite observer to the runner/engine concept; leave new statements without a `verified` entry until checked against the code.

- [ ] **Docs guard** (no new file)
  - Verify: `grep -rniE "verified on|confirmed live|app\.wardby\.com|knock-knock" docs help README.md deploy --include='*.md'` returns nothing new; `grep -rniE "datadog" docs help README.md deploy --include='*.md'` shows only the generic collector sentence added here.
  - Files: none
  Ensures Appendix A (private) did not leak into tracked docs.

- [ ] **PR description** (at ship time)
  - States what was added to `docs/` and `help/` and why `docs/coding-worker-isolation.md` changed (CLAUDE.md requirement).

## Success Criteria

### Automated Verification:
- [ ] `npm run build:help && npm test`
- [ ] `npx prettier --check .`
- [ ] `/okf:validate .okf --strict`
- [ ] Docs guard greps as above

### Manual Verification:
- [ ] A reader can enable metrics on both processes, apply and patch the NetworkPolicy component, and scrape with their collector using only the docs.
- [ ] No tracked doc contains our hostnames, namespaces, test runs or PR history, and Datadog appears only as a generic collector example.

**Implementation Note**: last phase; final review against the spec's Definition of Done.

## References
- Spec: Acceptance Criteria (docs and help), Boundaries (NEVER vendor-specific)
- CLAUDE.md sections "Public docs are for operators" and "Every feature gets a docs + help check"
