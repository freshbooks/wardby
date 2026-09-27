---
id: errors/service-unready
title: Service did not become ready
summary: A coding run failed at launch because one of its service sidecars never passed its readiness check.
audience: operator
tags: [error, coding-agents, services, kubernetes]
appliesTo: >=0.2.1
---

# Service did not become ready

A run that failed with category `service_unready` (launcher error
`coding_service_unready:<name>`) started its pod, but the named service's
sidecar never became ready, so the coding agent never started. A service is
not ready when its readiness command keeps failing past its failure threshold,
its image cannot be pulled or started, or it has still not started when the
launcher's pod-start bound runs out.

1. Inspect the run pod's init-container status and events for the
   `service-<name>` container: image pull errors, crash loops, or probe
   failures.
2. For a custom catalog entry, confirm the image runs as a non-root user with a
   read-only root filesystem: every directory it writes to must be its
   `dataPath` or one of its `writablePaths`. Probe over TCP on `127.0.0.1`
   rather than a Unix socket.
3. Readiness is bounded by the launcher's pod-start timeout
   (`KUBERNETES_READY_TIMEOUT_MS`, default 120000) whatever the entry's
   threshold. If first image pulls on new nodes are slow, raise that bound or
   mirror the image into a nearby registry.
4. Trigger a new run once the cause is fixed.

See [Coding services](../coding-services.md).
