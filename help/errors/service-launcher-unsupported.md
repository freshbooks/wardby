---
id: errors/service-launcher-unsupported
title: Services need the Kubernetes launcher
summary: Wardby refused the coding run because the repository declares services and this deployment's job launcher cannot start them.
audience: operator
tags: [error, coding-agents, services, kubernetes, docker, refusal]
appliesTo: >=0.2.1
---

# Services need the Kubernetes launcher

`service_launcher_unsupported` means the repository declares services, but this
deployment runs coding workers on a launcher that cannot start them. Services
run as sidecars in the run's pod, so they need `JOB_LAUNCHER=kubernetes`; the
Docker launcher refuses such runs.

1. Run the coding agent on a deployment that uses the Kubernetes job launcher,
   or
2. remove `.wardby/services.yaml` from the base branch if the repository's
   tests do not need the services on this deployment.

Wardby does not start a run without the services a repository declares. See
[Coding-worker troubleshooting](../troubleshooting/coding-workers.md) and
[Coding services](../coding-services.md).
