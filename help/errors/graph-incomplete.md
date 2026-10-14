---
id: errors/graph-incomplete
title: Package still being checked (wardby_graph_incomplete)
summary: The registry is still checking the package against the allowed dependency graph, usually after a transient registry problem; retry shortly.
audience: operator
tags: [error, coding-agents, packages, allowlist, wardby_graph_incomplete]
appliesTo: ">=0.6.1"
---

# Package still being checked

`wardby_graph_incomplete` (HTTP 503) means the requested package is still
being checked against the allowed packages' dependency graph, typically because
the registry or audit service failed while part of the graph was read. The
error message shows the walk's progress. It never means the package is
outside the graph.

## What the agent should do

This is the one allowlist-related code worth retrying: try again shortly (npm
retries a 5xx on its own). If it keeps happening, report the package so its
owner can allowlist it directly.

## What the owner does

If retries do not clear it, add the package to
`codingProfile.packageAllowlist` with `update_agent` (needs
`packages:approve` or `agents:admin`).

## Related

- [Package not reached: `wardby_package_not_allowed_pending`](package-not-allowed-pending.md)
- [Not allowed: `wardby_package_not_allowed`](package-not-allowed.md)
- [Graph limit: `wardby_graph_limit`](graph-limit.md)
- [Coding packages](../coding-packages.md)
