---
id: coding-services
title: Give coding runs the services their tests need
summary: Let coding runs on the Kubernetes launcher start fresh PostgreSQL, Redis or MySQL sidecars declared in the repository's .wardby/services.yaml.
audience: operator
tags: [coding-agents, services, postgres, redis, mysql, kubernetes]
appliesTo: >=0.2.1
---

# Give coding runs the services their tests need

A coding run can have a PostgreSQL, Redis or MySQL instance next to it for the
length of the run. Three parties agree before a service starts:

- **The repository** declares it in `.wardby/services.yaml` on its base branch,
  for example `services: { postgres: "16" }`. Wardby reads the file from the
  base branch, never from the run's own branch, so a change takes effect only
  after it is merged.
- **The service catalog** says what each name and version is: a digest-pinned
  image, its readiness check, resources, and the variables the agent's shells
  receive (`testEnv`, such as `DATABASE_URL`). `list_services` and
  `get_service` need `agents:read`. `create_service`, `update_service` and
  `delete_service` need `services:manage` and the `admin` or
  `service-manager` role. Built-in entries (`postgres` 15, 16 and 17, `redis`
  7, `mysql` 8) cannot be changed over MCP.
- **The agent's owner** lists the catalog names its runs may use in
  `codingProfile.services`. An empty list, the default, allows none.

Services need the Kubernetes job launcher. Each run gets its own empty
instance as a native sidecar in the run's pod, reachable on `127.0.0.1`; the
run's sandbox and NetworkPolicy do not change, and the instance is deleted with
the pod. Each sidecar's CPU, memory and disk count toward the run's pod, its
namespace quota, and what a managed cluster bills for it.

Catalog values are visible to anyone with `agents:read`. Use throwaway test
credentials only; never put a real secret in `serviceEnv` or `testEnv`.

Every run protects `.wardby/**` except `.wardby/services.yaml`, so a coding
agent may propose a declaration change in its pull request but cannot change
other `.wardby/` files. An agent's own `protectedPaths` exceptions (entries
starting with `!`) must be literal file paths and cannot unprotect `.wardby/`.

When upgrading a deployment that delegates to an identity provider, define the
`services:manage` scope in the provider first; see
[Configure identity and privileged access](identity-and-access.md).

If a run is refused or fails over its services, read the page for its code:

- [`service_declaration_invalid`](errors/service-declaration-invalid.md)
- [`service_declaration_unavailable`](errors/service-declaration-unavailable.md)
- [`service_unknown`](errors/service-unknown.md)
- [`service_not_allowed`](errors/service-not-allowed.md)
- [`service_launcher_unsupported`](errors/service-launcher-unsupported.md)
- [`service_unready`](errors/service-unready.md)

Read [`docs/coding-services.md`](../docs/coding-services.md) for the file
format, catalog fields, built-in variables, custom entries, and capacity.
