---
id: coding-packages
title: Approve packages for coding agents
summary: Let Codex coding workers install vetted npm and PyPI dependencies through Wardby's registry proxy.
audience: operator
tags: [coding-agents, packages, npm, pypi, supply-chain, refusals, lockfile]
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

Registry mode works for Codex and Claude Code runs alike, on the `node`
toolchain (npm) and the `node-python` toolchain (npm and pip). Claude Code runs
its shell commands in a separate, credential-free tool-runner container that
reaches the registry through the run's proxy network. Use a pinned custom
worker image when an agent needs system packages, another runtime, or
dependencies that should be baked into the image.

When the registry refuses a package, the pull request opens with a
**Dependency install incomplete** warning naming each refused package and
any lock file the run changed. A changed lock file may then fail a clean
install in CI until it is regenerated, and the run's status comment shows ⚠️
if its own checks failed. A package reachable only through a refused one is
refused too, so a high-severity advisory deep in a toolchain blocks every run
that installs it.

Read [`docs/coding-packages.md`](../docs/coding-packages.md) for allowlist
syntax, package-policy controls, lockfile behavior, and refusal errors.
