---
id: coding-packages
title: Approve packages for coding agents
summary: Let Codex coding workers install vetted npm and PyPI dependencies through Wardby's registry proxy.
audience: operator
tags: [coding-agents, packages, npm, pypi, supply-chain]
appliesTo: >=0.2.1
---

# Approve packages for coding agents

Coding workers have no direct registry network access. For **Codex** workers,
Wardby's registry proxy can allow `npm install` and `pip install` from a
per-agent npm or PyPI allowlist. The proxy records what was fetched and applies
supply-chain checks, including package graph validation, release-age policy,
and vulnerability filtering.

An empty allowlist keeps registry mode off. Approve only top-level packages;
Wardby validates and permits the required transitive dependency graph for the
run. Changing a package allowlist or policy needs `packages:approve` (or
`agents:admin`) and a Wardby `admin` or `package-approver` role.

Registry mode does not currently support Claude Code workers because their
tool-runner container has no network attachment. Use a pinned custom worker
image when an agent needs system packages, another runtime, or dependencies
that should be baked into the image.

Read [`docs/coding-packages.md`](../docs/coding-packages.md) for allowlist
syntax, package-policy controls, lockfile behavior, and refusal errors.
