---
id: errors/service-unready
title: Service did not become ready
summary: A coding run failed at launch because one of its services never passed its readiness check.
audience: operator
tags: [error, coding-agents, services, kubernetes, docker]
appliesTo: >=0.2.1
---

# Service did not become ready

A run that failed with category `service_unready` (launcher error
`coding_service_unready:<name>`) started, but the named service never became
ready, so the coding agent never started. A service is not ready when its
readiness command keeps failing past its failure threshold, its image cannot
be pulled or started, or it is still not ready when the launcher's start-up
limit runs out.

1. On Kubernetes, inspect the run pod's init-container status and events for
   the `service-<name>` container: image pull errors, crash loops, or probe
   failures. On Docker the service's container is removed with the failed run,
   so reproduce it on the Docker host: pull the entry's image and run it with
   `--read-only`, `--user 10001:10001`, a `--tmpfs` at its `dataPath` and at
   each `writablePaths` entry, and its `serviceEnv`; then run its readiness
   command with `docker exec`.
2. For a custom catalog entry, confirm the image runs as a non-root user with a
   read-only root filesystem: every directory it writes to must be its
   `dataPath` or one of its `writablePaths`. Probe over TCP on `127.0.0.1`
   rather than a Unix socket.
3. Each entry's readiness settings (`periodSeconds`, `timeoutSeconds`,
   `failureThreshold`) apply within an overall start-up limit, whatever the
   entry's own threshold would otherwise allow. On Kubernetes that limit is
   the pod-start timeout (`KUBERNETES_READY_TIMEOUT_MS`, default 120000, an
   operator setting) and includes image pulls; if first pulls on new nodes
   are slow, raise it or mirror the image into a nearby registry. On Docker
   the limit is a fixed 120 seconds covering every service of the run
   together (they start one at a time), never runs past the run's own
   timeout, and has no setting to raise it; image pulls are not counted in it
   but may take up to 5 minutes each. The Docker launcher pulls without
   registry credentials, so pull a private or rate-limited image on the
   Docker host beforehand.
4. Trigger a new run once the cause is fixed.

When this run is a sub-run another agent dispatched (for example a router
handing work to a coding agent), the parent sees a failed sub-run on its own
status comment, with a line naming the service: "A sub-run could not start:
The `<name>` service didn't become ready, so the run couldn't start."

See [Coding services](../coding-services.md).
