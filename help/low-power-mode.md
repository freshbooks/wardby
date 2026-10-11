---
id: low-power-mode
title: Low power mode on GKE
summary: Low power mode: scale the coding proxy and native gateway to zero when idle to cut the cost of a lightly used GKE deployment, and what changes when they wake.
audience: operator
tags: [gke, cost, low-power, scale-to-zero, kubernetes, autoscaling, idle]
appliesTo: ">=0.6.0"
---

# Low-power mode on GKE

Low-power mode reduces the cost of a GKE Autopilot deployment that runs agents
only occasionally. When it is on, the coding proxy and the native gateway scale
to zero replicas after an idle window and wake when a run needs them. The
headroom placeholder is off, and the control plane runs 1 copy that scales to 2
under load.

It needs `JOB_LAUNCHER=kubernetes`. Without it Wardby logs `low_power_ignored`
and the mode does nothing.

## Turn it on or off

```sh
WARDBY_HOSTNAME=wardby.example.com WARDBY_LOW_POWER=1 deploy/gke/up.sh
```

Re-running `up.sh` without `WARDBY_LOW_POWER=1` turns it off: it removes the
autoscaler `wardby-control-plane` and the Role and RoleBinding `wardby-power`
and restores proxy 1, gateway 2, headroom 1, control plane 1.

`WARDBY_LOW_POWER` accepts only unset, `0` or `1`; anything else fails `up.sh`
and stops the control plane at start-up. `LOW_POWER_IDLE_MINUTES` is an integer
from 5 to 1440 (default 30) set on the control-plane Deployment.

## How it behaves

- **Sleep.** Every minute the scheduler leader scales the coding proxy
  (`wardby-coding-proxy`) or native gateway (`wardby-native-gateway`) to 0 when
  nothing is pending or running for it and nothing finished within the idle
  window. The gateway also needs no active session and must have been woken at
  least one idle window ago (annotation `wardby.io/power-woke-at`). The check
  repeats just before scaling. Log: `power: proxy slept (idle 30m)`.
- **Wake.** A coding run scales the proxy to 1 and waits for a ready endpoint,
  up to `KUBERNETES_READY_TIMEOUT_MS` (default 120000). A sandbox run does the
  same for the gateway, up to `NATIVE_SANDBOX_READY_TIMEOUT_MS`. Expect about 1
  to 2 minutes extra on a cold node. Log: `power: proxy woke`.
- **Preflight.** The first coding run after a control-plane restart also runs
  the cluster preflight canary, because start-up preflight is deferred while the
  proxy sleeps (`kubernetes_preflight_deferred`).
- **Deploys.** A deploy leaves the proxy and gateway at 1 replica (its database
  checks need them); they sleep after the idle window.
- **Control plane.** It scales 1 to 2 on CPU (placeholder 40% target, scale down
  after 10 minutes). A run executes on the copy that started it, so scheduled
  runs stay on the scheduler leader; webhook and MCP-started runs spread. The
  autoscaler owns the replica count while the mode is on.

## Trade-offs and requirements

- With headroom off, the control plane has less protection against preemption.
- The gateway runs 1 replica instead of 2 while awake: no redundancy.
- `NATIVE_SANDBOX_WARM_POOL_SIZE` must be 0, or the control plane refuses to
  start.
- The gateway must be in the same namespace as `KUBERNETES_NAMESPACE`.

## Cost

Autopilot bills Pod requests while a Pod exists. At us-central1 list prices
($0.0445 per vCPU-hour, $0.0049225 per GiB-hour, 730 hours a month; use your
region's rates), always-on cost per workload is: control plane (1.1 vCPU / 2.125
GiB) $43.37, coding proxy (1.1 / 3.125) $46.96, native gateway (0.35 / 0.625 per
replica, two replicas) $27.23, headroom (0.25 / 0.5) $9.92. In low-power mode
the proxy costs $0.0643 an hour and a gateway replica $0.0187 an hour only
while awake, and headroom costs nothing. See
[Getting started on GKE](../docs/getting-started-gke.md#low-power-mode) for the
full table.

## Errors and log lines

- [`low_power_wake_timeout`](errors/low-power-wake-timeout.md): the target did
  not become ready in time, or its Deployment does not exist.
- [`low_power_scale_forbidden`](errors/low-power-scale-forbidden.md): the
  control plane may not scale the Deployment (Role `wardby-power` missing).
- Also: `power_sleep_failed`, `low_power_access_check_failed`,
  `low_power_ignored`.

## Local kind

`WARDBY_LOW_POWER=1 deploy/kind-coding/up.sh` applies the Role. The kind control
plane runs on your host, so set `WARDBY_LOW_POWER=1` (and optionally
`LOW_POWER_IDLE_MINUTES`) in the environment of `wardby serve` too.

Related: [Deploy Wardby on GKE Autopilot](deploy-gke.md),
[Run native agents in a sandbox](native-sandbox.md).
