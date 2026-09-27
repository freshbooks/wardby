---
id: troubleshooting/coding-workers
title: Troubleshoot coding workers
summary: Investigate coding-worker setup, isolation preflight, and safe failure handling.
audience: operator
tags: [coding-agents, docker, kubernetes, isolation]
appliesTo: >=0.2.1
---

# Troubleshoot coding workers

Before enabling a coding agent, configure an immutable worker image, the
trusted coding proxy, a scoped GitHub App installation, and the selected job
launcher. Run `wardby coding preflight` after changing the Docker or Kubernetes
configuration.

Wardby refuses to weaken an isolation profile when a required host feature,
network setting, mount, environment, or cleanup guarantee cannot be verified.
Investigate the host configuration instead of bypassing the refusal.

Codex and Claude Code workers have different supported launcher combinations.
Review the deployment guide for your target before assigning a coding profile.

For the specific isolation refusal, read [Coding-worker isolation unavailable](../errors/docker-isolation-unsupported.md).
