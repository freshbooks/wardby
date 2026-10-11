---
id: errors/low-power-scale-forbidden
title: Scaling forbidden by RBAC
summary: When waking a sleeping target, the control plane is not allowed to scale the coding proxy or native gateway because the wardby-power Role is missing.
audience: operator
tags: [error, low-power, gke, kubernetes, rbac, low_power_scale_forbidden]
appliesTo: ">=0.6.0"
---

# Low-power scale forbidden

`low_power_scale_forbidden` means the Kubernetes API refused to let the control
plane scale a Deployment. Low-power mode needs the Role `wardby-power` (and its
RoleBinding) in the namespace. At start-up the control plane warns
`low_power_scale_forbidden: missing ...` naming the missing permission; if the
check itself fails it logs `low_power_access_check_failed`.

1. Re-run the deploy with the mode on: `WARDBY_LOW_POWER=1 deploy/gke/up.sh`
   (on kind, `WARDBY_LOW_POWER=1 deploy/kind-coding/up.sh`). It applies the Role.
2. Confirm: `kubectl -n wardby-coding get role,rolebinding wardby-power`.
3. If you meant to turn the mode off, unset `WARDBY_LOW_POWER` on the control
   plane too, then re-run `up.sh` without it.
4. Trigger the run again.

See [Low-power mode on GKE](../low-power-mode.md).
