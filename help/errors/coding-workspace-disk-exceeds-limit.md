---
id: errors/coding-workspace-disk-exceeds-limit
title: Coding workspace larger than the deployment allows
summary: A coding run failed at start because its agent's workspaceDiskMb is larger than the deployment's CODING_MAX_DISK_MB (CODING_DISK_MB, 2048 MiB, when unset).
audience: operator
tags: [error, coding-agents, workspace, disk, workspaceDiskMb, CODING_MAX_DISK_MB]
appliesTo: ">=0.2.0"
---

# Coding workspace larger than the deployment allows

`coding_workspace_disk_exceeds_limit` (on the run record as
`coding_failure_workspace:<id>`) means the agent's
`codingProfile.workspaceDiskMb` is larger than the deployment's
`CODING_MAX_DISK_MB`. The run fails before a worker starts and costs nothing.
When `CODING_MAX_DISK_MB` is unset, the limit is `CODING_DISK_MB` (2048 MiB by
default).

Fix it one of two ways:

1. Lower the agent's size to the limit or below with `update_agent`:
   `{ "id": "<agent id>", "codingProfile": { "workspaceDiskMb": 2048 } }`.
2. Or raise the deployment's `CODING_MAX_DISK_MB` on the control plane and
   restart it. On GKE, deploy with `CODING_MAX_DISK_MB=8192 deploy/gke/up.sh`
   (see the GKE deploy guide). On GKE Autopilot the value must leave room for the
   worker's 1 GiB inside the 10 GiB pod ephemeral-storage ceiling.

A run that installs more than its workspace holds is evicted mid-run instead;
that needs a larger `workspaceDiskMb`, within this limit. See
[Build a worker image](../build-worker-image.md).
