---
id: errors/graph-limit
title: Dependency graph over the limit (wardby_graph_limit)
summary: The package's dependency graph is larger than REGISTRY_MAX_GRAPH_PACKAGES; allowlist the package directly or raise the limit.
audience: operator
tags: [error, coding-agents, packages, allowlist, wardby_graph_limit, REGISTRY_MAX_GRAPH_PACKAGES]
appliesTo: ">=0.6.1"
---

# Dependency graph over the limit

`wardby_graph_limit` (HTTP 403) means resolving the requested package needs
more than `REGISTRY_MAX_GRAPH_PACKAGES` package names (default 3000, counted
per run and ecosystem). The bound is permanent for the run, so retrying does
not help.

Large frameworks (for example Expo) can exceed the limit, because the walk
follows every in-range kept version plus optional and peer dependencies, so its
graph is usually several times larger than a single install.

## What the agent should do

Stop retrying. Report the package so its owner can act.

## What the owner does

1. Open the agent with `get_agent`, then add the package (or the top-level package that needs it) to `codingProfile.packageAllowlist` with `update_agent`. This needs `packages:approve` or `agents:admin`.
2. Run the request again. Allowing a package name allows all of its kept versions, subject to the release-age and vulnerability checks.

Alternatively the operator can raise `REGISTRY_MAX_GRAPH_PACKAGES` on the
coding proxy. A higher limit uses more proxy memory and walk time.

## Related

- [Package not reached: `wardby_package_not_allowed_pending`](package-not-allowed-pending.md)
- [Not allowed: `wardby_package_not_allowed`](package-not-allowed.md)
- [Still being checked: `wardby_graph_incomplete`](graph-incomplete.md)
- [Coding packages](../../docs/coding-packages.md#operator-limits)
