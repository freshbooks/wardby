---
id: errors/service-unknown
title: Service not in the catalog
summary: Wardby refused the coding run because the repository declares a service name and version the service catalog does not have.
audience: operator
tags: [error, coding-agents, services, refusal]
appliesTo: >=0.2.1
---

# Service not in the catalog

`service_unknown` means `.wardby/services.yaml` on the base branch asks for a
name and version, such as `postgres 14`, that has no entry in Wardby's service
catalog. Wardby refuses the run before a coding worker starts.

1. Run `list_services` (needs `agents:read`) to see the names and versions
   available.
2. Either change the declaration on the base branch to an available version,
   or ask someone with `services:manage` and the `admin` or `service-manager`
   role to add the entry with `create_service`, pinned by digest.
3. Trigger a new run once the catalog or the declaration matches.

See [Coding services](../coding-services.md).
