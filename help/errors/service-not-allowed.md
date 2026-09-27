---
id: errors/service-not-allowed
title: Service not allowed for this agent
summary: Wardby refused the coding run because the repository declares a service the agent's codingProfile.services does not allow.
audience: operator
tags: [error, coding-agents, services, refusal]
appliesTo: >=0.2.1
---

# Service not allowed for this agent

`service_not_allowed` means the repository declares a service that exists in
the catalog, but the agent's `codingProfile.services` does not list its name.
Wardby refuses the run before a coding worker starts.

1. Confirm the repository should have the service; the declaration is on the
   base branch in `.wardby/services.yaml`.
2. If it should, the agent's owner (or an admin) adds the name, for example
   `postgres`, to `codingProfile.services` with `update_agent`. Allowing a name
   allows every version the catalog has for it.
3. Trigger a new run.

Each allowed service reserves CPU, memory and disk for the whole run, so allow
only what the agent's repositories need. See [Coding services](../coding-services.md).
