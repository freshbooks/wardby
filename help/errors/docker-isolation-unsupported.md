---
id: errors/docker-isolation-unsupported
title: Coding-worker isolation unavailable
summary: Wardby refused to launch a coding worker because it could not verify the required isolation controls.
audience: operator
tags: [error, coding-agents, docker, isolation]
appliesTo: >=0.2.1
---

# Coding-worker isolation unavailable

`docker_isolation_unsupported` means a required worker-isolation guarantee was
missing, unexpected, or could not be inspected. Wardby fails closed rather than
running a worker with a weaker profile.

1. Run `wardby coding preflight` and correct the reported launcher, image,
   proxy-network, or host-support issue.
2. Confirm worker images are immutable image IDs or digests, not mutable tags.
3. Confirm the trusted proxy and worker use the intended isolated network and
   that no unapproved host mount, Docker socket, environment, or network path
   is present.
4. Re-run preflight before triggering another coding run.

If the deployment target does not support the selected coding provider, choose
a supported launcher/provider combination instead of disabling the controls.
See [Coding-worker troubleshooting](../troubleshooting/coding-workers.md).
