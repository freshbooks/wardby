---
id: errors/low-power-scale-forbidden
title: Scaling forbidden by RBAC
summary: In low-power mode, the control plane is not allowed to read or scale the coding proxy or native gateway Deployment, or read its Endpoints, because the wardby-power Role is missing or out of date.
audience: operator
tags: [error, low-power, gke, kubernetes, rbac, low_power_scale_forbidden]
appliesTo: ">=0.6.0"
---

# Low-power scale forbidden

`low_power_scale_forbidden` means the Kubernetes API refused the control plane
something low-power mode needs: reading or scaling the coding proxy or native
gateway Deployment, or reading its Endpoints to see whether a woken target is
ready. The message names the action and the object, for example
`may not get Endpoints "wardby-native-gateway"`. It can come from a run waking a
target, from `power_status`, or from `power_sleep`.

Low-power mode needs the Role `wardby-power` (and its RoleBinding) in the
namespace. It grants `get` and `patch` on the two Deployments and `get` on
their Endpoints, by name. At start-up the control plane warns
`low_power_scale_forbidden: missing ...` naming each missing permission (for
example `get endpoints/wardby-native-gateway`); if the check itself fails it
logs `low_power_access_check_failed`.

1. Re-run the deploy with the mode on: `WARDBY_LOW_POWER=1 deploy/gke/up.sh`
   (on kind, `WARDBY_LOW_POWER=1 deploy/kind-coding/up.sh`). It applies the
   current Role, including the Endpoints rule an older Role may lack.
2. Confirm: `kubectl -n wardby-coding describe role wardby-power` lists both
   rules, and `kubectl -n wardby-coding get rolebinding wardby-power` exists.
3. If you meant to turn the mode off, unset `WARDBY_LOW_POWER` on the control
   plane too, then re-run `up.sh` without it.
4. Trigger the run again.

See [Low-power mode on GKE](../low-power-mode.md).
