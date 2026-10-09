# Scrapable metrics Phase 2: Deploy scrape wiring

**Spec:** `.claude/thoughts/investigations/2026-10-09-scrapable-metrics-spec.md`
**Jira:** none yet
**Depends on:** Phase 1 complete (control plane serves `/metrics` when `METRICS_BIND` is set)

---

## Table of Contents

- [Overview](#overview)
- [Current State Analysis](#current-state-analysis)
- [Changes Required](#changes-required)
- [Success Criteria](#success-criteria)
- [References](#references)

---

## Overview

Expose the metrics endpoints in the Kubernetes manifests without weakening default-deny: declare the port and bind env, add generic Prometheus-convention annotations, and ship an **opt-in** NetworkPolicy component that lets an operator-chosen scraper reach port 9464. Update the local Prometheus/Grafana stack to scrape the control plane. Pin the security properties with manifest tests.

## Current State Analysis

- `deploy/kind-coding/manifests/base/default-deny.yaml:9-13` denies all ingress and egress in `wardby-coding`.
- Proxy Deployment (`base/proxy.yaml:6-76`): ports `proxy` 8787, `deny` 8788; no `METRICS_BIND`. Proxy NetworkPolicy (`:95-161`) allows ingress only from `wardby.io/component=coding-run` pods on 8787/8788.
- Control-plane Deployment (`overlays/gke-autopilot/control-plane.yaml:61-395`): container `control-plane` port `mcp` 8080 (`:345-347`); NetworkPolicy `wardby-control-plane` (`:418-506`) has no ingress; `wardby-control-plane-lb` (`control-plane-gateway.yaml:126-145`) allows LB ranges to 8080.
- Worker run policy: egress only to the proxy on 8787 (`src/providers/jobs/kubernetes-isolation.ts:514-532`).
- `deploy/observability/prometheus.yml` scrapes only `coding-proxy:9464`; `docker-compose.grafana.yml:16-17` sets `METRICS_BIND` for the proxy container.
- Existing manifest tests: `overlays/gke-autopilot/executor.test.mjs`, `priority.test.mjs` (Vitest + `loadAllYaml`, included by `vitest.config.ts` pattern `deploy/**/*.test.mjs`).

### Key Discoveries
- Policies are additive, so a new allow policy for the metrics port cannot weaken the existing ones; the risk is only in the selectors, hence the tests.
- `kustomize` standalone is not installed, but `kubectl kustomize` is.
- The kind overlay runs the control plane on the host (no control-plane Deployment there), so it only gets the proxy changes from `base/`.

## Changes Required

- [ ] **Proxy: metrics port, env, annotations** (`deploy/kind-coding/manifests/base/proxy.yaml`)
  - Verify: `npx vitest run deploy/kind-coding` and `kubectl kustomize deploy/kind-coding/manifests/overlays/kind > /dev/null`
  - Files: that file
  Add container port `metrics: 9464` (`:40-44`), env `METRICS_BIND=0.0.0.0:9464` and `METRICS_ALLOW_NON_LOOPBACK=true`, and pod annotations `prometheus.io/scrape: "true"`, `prometheus.io/port: "9464"`, `prometheus.io/path: "/metrics"`. Do **not** add the port to the proxy Service (scrape is pod-to-pod; the Service stays 8787/8788 so `coding-run` pods have no Service path to it) and do **not** touch the proxy NetworkPolicy ingress.

- [ ] **Control plane: metrics port, env, annotations** (`deploy/kind-coding/manifests/overlays/gke-autopilot/control-plane.yaml`)
  - Verify: `npx vitest run deploy/kind-coding`
  - Files: that file
  Add container port `metrics: 9464` next to `mcp: 8080` (`:345-347`), env `METRICS_BIND=0.0.0.0:9464` and `METRICS_ALLOW_NON_LOOPBACK=true`, and the same three annotations. Not added to the `wardby-control-plane` Service, the Gateway, the HTTPRoute, the `GCPBackendPolicy` or the health check.

- [ ] **Opt-in scrape NetworkPolicy component** (`deploy/kind-coding/manifests/components/metrics-scrape/kustomization.yaml`, `.../scrape-ingress.yaml`, `.../README.md`)
  - Verify: `kubectl kustomize deploy/kind-coding/manifests/components/metrics-scrape > /dev/null`
  - Files: those three
  ```yaml
  # kustomization.yaml
  apiVersion: kustomize.config.k8s.io/v1alpha1
  kind: Component
  resources: [scrape-ingress.yaml]
  ---
  # scrape-ingress.yaml
  apiVersion: networking.k8s.io/v1
  kind: NetworkPolicy
  metadata: { name: wardby-metrics-scrape }
  spec:
    podSelector:
      matchExpressions:
        - { key: app.kubernetes.io/name, operator: In, values: [wardby-coding-proxy, wardby-control-plane] }
    policyTypes: [Ingress]
    ingress:
      - from:
          - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: wardby-metrics-scraper-namespace } }
            podSelector: { matchLabels: { app.kubernetes.io/name: wardby-metrics-scraper } }
        ports: [{ protocol: TCP, port: 9464 }]
  ```
  The two placeholders are patched by the operator's own overlay (README shows a `kubectl kustomize`-compatible JSON patch). Confirm the control-plane pod's actual `app.kubernetes.io/name` label in `control-plane.yaml` before finalising the `values` list. Not referenced from any shipped overlay (opt-in).

- [ ] **Manifest tests** (`deploy/kind-coding/manifests/overlays/gke-autopilot/metrics.test.mjs`)
  - Verify: `npx vitest run deploy/kind-coding/manifests/overlays/gke-autopilot/metrics.test.mjs`
  - Files: that file
  Assertions (pattern from `executor.test.mjs`):
  - proxy and control-plane containers declare port 9464 named `metrics` and env `METRICS_BIND=0.0.0.0:9464`, `METRICS_ALLOW_NON_LOOPBACK=true`;
  - neither Service exposes 9464; the Gateway/HTTPRoute/GCPBackendPolicy/HealthCheck do not reference 9464;
  - the component policy has `policyTypes: ["Ingress"]` only (no egress), one ingress rule, TCP 9464 only, `from` is exactly the placeholder namespace + pod selector, and the serialized policy contains no `wardby.io/component` / `coding-run`;
  - the component is not in any shipped overlay's `resources` or `components`;
  - the base proxy NetworkPolicy ingress is unchanged (still `coding-run` on 8787 and 8788 only).
  Also run the existing `src/providers/jobs/kubernetes-isolation*.test.ts` unchanged to prove the worker run policy is untouched.

- [ ] **Local Prometheus second job** (`deploy/observability/prometheus.yml`, `deploy/observability/docker-compose.grafana.yml`)
  - Verify: `docker compose -f deploy/local/docker-compose.yml -f deploy/local/docker-compose.phase5.yml -f deploy/observability/docker-compose.grafana.yml config > /dev/null`
  - Files: those two
  Add job `wardby-control-plane` with target `host.docker.internal:9465` (the control plane runs on the host in the local workflow; operators start it with `METRICS_BIND=0.0.0.0:9465 METRICS_ALLOW_NON_LOOPBACK=true`), and `extra_hosts: ["host.docker.internal:host-gateway"]` on the `prometheus` service for Linux. The job showing `down` when no host process runs is expected; the smoke script keeps checking only the proxy target.

- [ ] **Smoke script covers the control-plane target when present** (`scripts/grafana-smoke.mjs`)
  - Verify: `node scripts/grafana-smoke.mjs` against a running stack
  - Files: that file
  Keep the existing proxy check mandatory; add an informational line reporting the control-plane target's `up` value, never failing on it.

- [ ] **Dashboard check** (`deploy/observability/grafana/dashboards/wardby-coding-proxy.json`)
  - Verify: dashboard JSON still parses (`node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" <file>`)
  - Files: that file (title only)
  Rename the panel "Coding Jobs and Cleanup Failures (Application Exporter)" to "Coding Jobs and Cleanup Failures (Control Plane)" so its source is accurate; queries stay unchanged. No other dashboard edits.

## Success Criteria

### Automated Verification:
- [ ] `npx vitest run deploy/kind-coding src/providers/jobs`
- [ ] `kubectl kustomize deploy/kind-coding/manifests/overlays/gke-autopilot > /dev/null`
- [ ] `kubectl kustomize deploy/kind-coding/manifests/overlays/kind > /dev/null`
- [ ] `kubectl kustomize deploy/kind-coding/manifests/components/metrics-scrape > /dev/null`
- [ ] `npm run test:production-boundary`
- [ ] `npm run typecheck && npm run lint && npm run format:check`

### Manual Verification:
- [ ] On a test cluster with the component patched to a test scraper: scraper pod reaches `:9464` on both pods; a `coding-run` pod and an unrelated pod cannot (e.g. `kubectl exec` a `nc -z -w2` check).
- [ ] The worker preflight enforcement canary still passes (proxy 8787 reachable, 8788 blocked, no new reachability).
- [ ] Without the component applied, nothing outside the pod can reach 9464.
- [ ] Local stack: both targets visible in Prometheus; the renamed panel shows data after a fake run.

**Implementation Note**: pause for confirmation before Phase 3. Plan output from any test cluster stays local; never commit real namespaces, hostnames or project ids.

## References
- Spec: Decisions 5, 6, 7 and Appendix A (private)
- `deploy/kind-coding/manifests/base/proxy.yaml:6-161`, `overlays/gke-autopilot/control-plane.yaml:61-506`, `control-plane-gateway.yaml:126-145`, `src/providers/jobs/kubernetes-isolation.ts:514-532`
