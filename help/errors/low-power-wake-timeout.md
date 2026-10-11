---
id: errors/low-power-wake-timeout
title: Wake timed out (scale to zero)
summary: When scaling from zero, the coding proxy or native gateway did not become ready after being scaled up, or its Deployment does not exist.
audience: operator
tags: [error, low-power, gke, kubernetes, scale-to-zero, low_power_wake_timeout]
appliesTo: ">=0.6.0"
---

# Low-power wake timed out

`low_power_wake_timeout` means a run needed the coding proxy (or, for a sandbox
run, the native gateway), Wardby scaled it from 0 to 1, and no ready endpoint
appeared within the bound. The bound is 5 minutes, or
`KUBERNETES_READY_TIMEOUT_MS` for the proxy and
`NATIVE_SANDBOX_READY_TIMEOUT_MS` for the gateway when that is higher. It is
also raised when the target Deployment does not exist.

1. Check the Deployment exists: `kubectl -n wardby-coding get deploy wardby-coding-proxy wardby-native-gateway`
   (names follow `KUBERNETES_PROXY_SERVICE` and `NATIVE_GATEWAY_SERVICE`). If
   one is missing, re-run `deploy/gke/up.sh`.
2. If it exists, look at why its Pod is not ready: `kubectl -n wardby-coding describe pod -l app.kubernetes.io/name=wardby-coding-proxy`.
   A cold Autopilot node can take 1 to 2 minutes; unschedulable Pods, image
   pull errors or a failing sidecar are the usual causes.
3. If the node is simply slow, raise the timeout for that target above 5
   minutes (300000): set `KUBERNETES_READY_TIMEOUT_MS` (proxy) or
   `NATIVE_SANDBOX_READY_TIMEOUT_MS` (gateway) on the control-plane Deployment.
4. Trigger the run again.

See [Low-power mode on GKE](../low-power-mode.md).
