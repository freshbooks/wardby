---
id: errors/service-launcher-unsupported
title: Services are not available to this run
summary: Wardby refused the coding run because the repository declares services and this deployment or agent cannot start them.
audience: operator
tags: [error, coding-agents, services, kubernetes, docker, refusal]
appliesTo: >=0.2.1
---

# Services are not available to this run

`service_launcher_unsupported` means the repository declares services, but this
run cannot have them. Services need both:

- a job launcher that starts them: `JOB_LAUNCHER=kubernetes` or
  `JOB_LAUNCHER=docker` (a deployment with `JOB_LAUNCHER=local` cannot), and
- a Codex coding agent. A Claude Code agent's repository commands run in a
  container with no network, so they could not reach a service.

1. Run the coding agent on a deployment that uses the Kubernetes or Docker job
   launcher, or use a Codex coding agent for this repository, or
2. remove `.wardby/services.yaml` from the base branch if the repository's
   tests do not need the services.

This error only applies to an agent that already allows at least one service
(`codingProfile.services` is non-empty): wardby reads a repository's
declaration only for such an agent, and refuses rather than silently starting
the run without the services it names. An agent that allows no services never
reads the declaration at all, so its runs are unaffected and start normally on
any launcher. See [Coding-worker troubleshooting](../troubleshooting/coding-workers.md)
and [Coding services](../coding-services.md).
