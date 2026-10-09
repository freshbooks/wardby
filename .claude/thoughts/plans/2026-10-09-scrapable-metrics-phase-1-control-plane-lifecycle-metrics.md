# Scrapable metrics Phase 1: Control-plane lifecycle metrics

**Spec:** `.claude/thoughts/investigations/2026-10-09-scrapable-metrics-spec.md`
**Jira:** none yet
**Depends on:** None — first phase (start from a new branch off `main`)

---

## Table of Contents

- [Overview](#overview)
- [Current State Analysis](#current-state-analysis)
- [Changes Required](#changes-required)
- [Success Criteria](#success-criteria)
- [References](#references)

---

## Overview

Make the `wardby_coding_*` metrics real: build a control-plane metrics registry, feed it from the executor's lifecycle events through a composite observer, and serve it on `METRICS_BIND` from `serve`, `mcp` and `scheduler`. The proxy keeps its current metrics. No metric names or labels change.

## Current State Analysis

- `WardbyMetrics` registers both the `wardby_coding_*` and `wardby_proxy_*` families (`src/observability/metrics.ts:45-122`) and is constructed only in `src/coding-proxy/main.ts:29`. `WardbyMetrics.emit()` has no non-test caller.
- The executor emits lifecycle events through `this.observer` (`src/providers/executor/container.ts:605,1471-1477`), defaulting to `codingRunObserver` (Pino + in-memory) because `composition.ts:141-175` passes no `observer`.
- `buildConfiguredExecutor` (`composition.ts:49`) is called from `src/mcp/index.ts:199`, `src/cli.ts:702` and `src/cli.ts:793`.
- Long-running commands: `serve()` (`cli.ts:855-872` → `startServe`, `src/serve.ts:42-93`), `mcp()` (`cli.ts:832-853` → `startMcp`, `mcp/index.ts:247-438`), `scheduler()` (`cli.ts:~770-830`). Shutdown order for MCP HTTP is `mcp/index.ts:427-436`.
- `loadMetricsConfig` / `startMetricsServer` (`src/observability/config.ts:23`, `metrics-server.ts:15`) are process-agnostic.
- Existing tests: `src/observability/metrics.test.ts`, `config.test.ts`, `src/coding/observability.test.ts`, `src/providers/executor/container.test.ts` (uses `InMemoryCodingRunObserver`).

### Key Discoveries
- `ContainerExecutor.emit` swallows observer errors (`container.ts:1471-1477`); the composite must preserve that isolation per child.
- The shutdown path logs but does not abort on close failures (`closeQuietly`, `mcp/index.ts:238-244`); add the metrics-server close with the same helper.
- `cli.ts` `scheduler()` does not call `waitForInFlightRuns`; keep that behaviour, only add the metrics close.

## Changes Required

Order matters: registry scoping, then observer, then wiring.

- [ ] **Scope the registry** (`src/observability/metrics.ts`, `src/observability/metrics.test.ts`)
  - Verify: `npx vitest run src/observability/metrics.test.ts`
  - Files: those two
  ```ts
  export type MetricsScope = "all" | "proxy" | "control-plane";
  export class WardbyMetrics implements CodingRunObserver {
    constructor(registry = new Registry(), readonly scope: MetricsScope = "all") { /* register families per scope */ }
  }
  export const createProxyMetrics = () => new WardbyMetrics(new Registry(), "proxy");
  export const createControlPlaneMetrics = () => new WardbyMetrics(new Registry(), "control-plane");
  ```
  Proxy scope registers `wardby_proxy_*` + `wardby_nodejs_*`; control-plane scope registers `wardby_coding_*` + `wardby_nodejs_*`; `"all"` keeps today's behaviour (default, so existing tests pass). `emit` is a no-op for lifecycle if the scope lacks those families; `observeProxy*` likewise. Tests: each scope exposes exactly its families (assert on `registry.getMetricsAsJSON()` names), default metrics present in both, existing assertions unchanged.

- [ ] **Use the proxy scope in the proxy** (`src/coding-proxy/main.ts`)
  - Verify: `npx vitest run src/observability src/providers/coding-proxy`
  - Files: `src/coding-proxy/main.ts`
  - Replace `new WardbyMetrics()` (`:29`) with `createProxyMetrics()`. Scrape output loses the (always-zero) `wardby_coding_*` families from the proxy; the dashboard panel that used them reads from the control plane after Phase 2. Call this out in the PR description.

- [ ] **Composite observer** (`src/coding/observability.ts`, `src/coding/observability.test.ts`)
  - Verify: `npx vitest run src/coding/observability.test.ts`
  - Files: those two
  ```ts
  export class CompositeCodingRunObserver implements CodingRunObserver {
    constructor(private readonly observers: readonly CodingRunObserver[]) {}
    emit(event: CodingLifecycleEvent): void {
      for (const observer of this.observers) {
        try { observer.emit(event); } catch { /* one observer must not starve the others */ }
      }
    }
  }
  ```
  Tests: forwards to all children in order; a throwing child does not stop the others; no error escapes.

- [ ] **Control-plane metrics bootstrap** (`src/observability/control-plane.ts`, `src/observability/control-plane.test.ts`)
  - Verify: `npx vitest run src/observability/control-plane.test.ts`
  - Files: those two
  ```ts
  export interface ControlPlaneMetrics {
    observer: CodingRunObserver;            // Composite[codingRunObserver, WardbyMetrics(control-plane)]
    close(): Promise<void>;                 // closes the listener if one was started
    port?: number;
  }
  export async function startControlPlaneMetrics(env = process.env): Promise<ControlPlaneMetrics>;
  ```
  Behaviour: `loadMetricsConfig(env)`; always build the composite observer; start `startMetricsServer` only when `bind` is set; log `metrics.started` (module `control-plane-metrics`, same event name as the proxy). Tests: no bind → no listener, observer still records; bind `127.0.0.1:0`-style test port → `GET /metrics` returns `wardby_coding_lifecycle_events_total` after one `emit({stage:"queued",runId:"r"})`; invalid bind throws the existing error; `close()` is idempotent.

- [ ] **Thread the observer through the executor build** (`src/providers/executor/composition.ts`, `src/mcp/index.ts`, `src/cli.ts`, `src/serve.ts`)
  - Verify: `npx vitest run src/providers/executor src/serve.test.ts`
  - Files: those four
  `buildConfiguredExecutor(..., { observer })` forwards `observer` to `new ContainerExecutor({... observer })` (`composition.ts:141`). `buildMcpProviders` (`mcp/index.ts:160-216`) and the `cli.ts` callers (`:702`, `:793`) accept and pass it. `startServe` (`serve.ts:42`) and `startMcp` (`mcp/index.ts:247`) create `startControlPlaneMetrics()` **before** building providers and close it in the existing shutdown order after `executor.close()` and `modelCatalog.close()` (never before in-flight runs have drained). `cli.ts scheduler()` does the same. When a caller passes no observer (tests, offline paths) the executor default is unchanged.

- [ ] **Executor wiring test** (`src/providers/executor/container.test.ts` or a new `composition.test.ts`)
  - Verify: `npx vitest run src/providers/executor`
  - Files: one test file
  Assert `buildConfiguredExecutor` with an `InMemoryCodingRunObserver` receives `queued`→…→`terminal`→`cleanup` events for a fake run, and that, with the composite, `WardbyMetrics(control-plane)` shows `wardby_coding_runs_terminal_total{outcome="succeeded"} 1` and `wardby_coding_active_jobs 0` afterwards.

- [ ] **End-to-end smoke test script** (`scripts/control-plane-metrics-smoke.mjs`, `package.json`)
  - Verify: `node scripts/control-plane-metrics-smoke.mjs`
  - Files: those two
  Starts `startControlPlaneMetrics` on an ephemeral port, emits a synthetic lifecycle sequence, fetches `/metrics`, asserts the expected series, exits non-zero otherwise. Add as `npm run observability:smoke:control-plane`. (Local only; no model request, no database.)

## Success Criteria

### Automated Verification:
- [ ] `npm run typecheck`
- [ ] `npm run lint && npm run format:check`
- [ ] `npm test` (Postgres-gated suites as today)
- [ ] `npx vitest run src/observability src/coding src/providers/executor src/providers/coding-proxy`
- [ ] `npm run build`
- [ ] `node scripts/control-plane-metrics-smoke.mjs`

### Manual Verification:
- [ ] Run `METRICS_BIND=127.0.0.1:9465 npm run cli -- serve` locally with a fake/dry run; `curl 127.0.0.1:9465/metrics` shows `wardby_coding_*` after the run and no `wardby_proxy_*`.
- [ ] Proxy `/metrics` (`METRICS_BIND` set) shows `wardby_proxy_*` and no `wardby_coding_*`.
- [ ] With `METRICS_BIND` unset nothing listens on a new port.
- [ ] SIGTERM during an in-flight run still drains as before (metrics server closes last).

**Implementation Note**: pause for confirmation before Phase 2.

## References
- Spec: Decisions 2, 3, 4, 5
- `src/providers/executor/container.ts:517,605,1471-1477`, `composition.ts:49,141-175`, `src/mcp/index.ts:160-216,247-438`, `src/serve.ts:42-93`, `src/cli.ts:702,793,832-872`
