---
id: errors/low-power-disabled
title: Scale-down refused, mode not enabled
summary: A request to put the coding proxy or native gateway to sleep was refused because WARDBY_LOW_POWER is not 1 on this deployment.
audience: operator
tags: [error, gke, kubernetes, low_power_disabled]
appliesTo: ">=0.6.0"
---

# Sleep refused: low-power mode not enabled

`low_power_disabled` (HTTP 409) means `power_sleep` was called, but low-power
mode is not on for this deployment: `WARDBY_LOW_POWER` is not `1` on the
control plane, or the control plane does not use `JOB_LAUNCHER=kubernetes` (it
then logs `low_power_ignored` at start-up). Nothing was scaled.

With the mode off, the coding proxy and native gateway always run, so there is
nothing to put to sleep. `power_status` returns `{ "enabled": false }` in the
same case.

To turn the mode on:

1. Deploy with the flag: `WARDBY_HOSTNAME=wardby.example.com WARDBY_LOW_POWER=1 deploy/gke/up.sh`.
   On a local kind cluster, use `WARDBY_LOW_POWER=1 deploy/kind-coding/up.sh` and
   also set `WARDBY_LOW_POWER=1` in the environment of `wardby serve`.
2. Check that the control plane runs with `JOB_LAUNCHER=kubernetes`.
3. Call `power_status`; it reports `"enabled": true` once the mode is on.

See [Low-power mode on GKE](../low-power-mode.md).
