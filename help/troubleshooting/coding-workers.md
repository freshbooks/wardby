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

## Cluster preflight at start-up (Kubernetes)

With `JOB_LAUNCHER=kubernetes`, a long-running server process (`wardby
serve`, `wardby mcp` over either transport, or `wardby scheduler`) starts
the cluster preflight as soon as it starts, instead of waiting for the
first coding run. Check the process's start-up log for the result: an info
line when the preflight passes, or a warning naming the failure code (the
same `kubernetes_isolation_unsupported:<check>` codes `wardby coding
preflight` reports) when it does not.

A failed start-up preflight still fails every coding run in that process —
restart the process after fixing the underlying configuration; a running
process never re-probes the cluster on its own. Run `wardby coding
preflight` at any time for a one-off, non-memoized check against the same
cluster.

## Runs that stop at the turn limit

A Claude Code run whose failure category is `turn_limit` reached its agent's
turn limit (worker error `coding_turn_limit`): 200 model calls by default. The
work was too large for the limit, or the agent was looping. Read the run's
summary and debug trace (`codingProfile.debugTraceMinutes`) to tell which;
raise `codingProfile.maxTurns` (up to 1000) with `update_agent` for the first,
or narrow the task for the second. Codex runs have no turn limit. See
[Coding run reached its turn limit](../errors/coding-turn-limit.md).

## Runs that wait for cluster capacity

On Kubernetes with `KUBERNETES_RESOURCE_QUOTA` set, a run whose pod would not
fit the namespace quota stays `pending` with `codingQueuedAt` set, like a run
over `CODING_MAX_CONCURRENT`, and starts once other runs finish. A run still
waiting after `CODING_QUEUE_TIMEOUT_SEC` fails with `coding_queue_timeout`:
raise the quota, lower the run pods' size, or lower `CODING_MAX_CONCURRENT` so
fewer runs compete.

A lead agent with `parallelDelegations` starts several coding runs together;
expect some of them to queue when the lead fans out wider than the free slots.

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
  services need the Kubernetes or Docker job launcher.
- [`service_unready`](../errors/service-unready.md): the run started but a
  service never became ready (launcher error `coding_service_unready:<name>`).

See [Coding services](../coding-services.md).
