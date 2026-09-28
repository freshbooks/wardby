---
id: troubleshooting/coding-workers
title: Troubleshoot coding workers
summary: Investigate coding-worker setup, isolation preflight, and safe failure handling.
audience: operator
tags: [coding-agents, docker, kubernetes, isolation, services]
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

## Service refusals and failures

A repository can declare services such as PostgreSQL in `.wardby/services.yaml`
on its base branch. Wardby checks the declaration, the service catalog, and the
agent's `codingProfile.services` before a run starts, and refuses the run with a
`service_*` code when they disagree. The run's `error` (from `get_run`) is the
code followed by a sentence the requester also sees on the run's status comment.

- [`service_declaration_invalid`](../errors/service-declaration-invalid.md):
  the file on the base branch is not a valid declaration.
- [`service_declaration_unavailable`](../errors/service-declaration-unavailable.md):
  Wardby could not read the file through the GitHub App.
- [`service_unknown`](../errors/service-unknown.md): the catalog has no such
  name and version.
- [`service_not_allowed`](../errors/service-not-allowed.md): the agent does not
  allow that service.
- [`service_launcher_unsupported`](../errors/service-launcher-unsupported.md):
  services need the Kubernetes job launcher, or the Docker job launcher with a
  Codex coding agent.
- [`service_unready`](../errors/service-unready.md): the run started but a
  service never became ready (launcher error `coding_service_unready:<name>`).

See [Coding services](../coding-services.md).
