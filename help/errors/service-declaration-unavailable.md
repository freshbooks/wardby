---
id: errors/service-declaration-unavailable
title: Service declaration unavailable
summary: Wardby refused the coding run because it could not read .wardby/services.yaml from the base branch.
audience: operator
tags: [error, coding-agents, services, github, refusal]
appliesTo: >=0.2.1
---

# Service declaration unavailable

`service_declaration_unavailable` means Wardby could not read
`.wardby/services.yaml` from the run's base branch through the GitHub App, so
it could not tell which services the run needs. A missing file is not this
error (no file means no services); this is a failed read. Wardby refuses the
run rather than start it without services the repository may require.

1. Trigger the run again; the cause is often a transient GitHub error.
2. If it repeats, confirm the GitHub App installation still covers the
   repository and has contents read access, and that the agent's base branch
   exists.
3. Check the control-plane logs around the refusal for the GitHub response.

See [Repository access troubleshooting](../troubleshooting/repository-access.md)
and [Coding services](../coding-services.md).
