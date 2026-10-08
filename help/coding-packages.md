---
id: coding-packages
title: Approve packages for coding agents
summary: Let Codex coding workers install vetted npm and PyPI dependencies through Wardby's registry proxy.
audience: operator
tags: [coding-agents, packages, npm, pypi, supply-chain, refusals, lockfile, extras, pip-extras]
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

## PyPI extras

A PyPI entry may name extras, as pip does: `psycopg[binary]`,
`uvicorn[standard]>=0.30`. An extra allows only the dependencies that
package's own metadata declares under that extra (for `psycopg[binary]`, the
`psycopg-binary` wheel); a bare `psycopg` entry follows no extra, so
`psycopg-binary` is refused with `wardby_package_not_allowed`. A plain entry
follows no extras at all, its own or its dependencies': a plain `fastapi`
whose metadata asks for `uvicorn[standard]` gets bare `uvicorn` only. Extras a
dependency line names are followed only below an entry that names extras
(`fastapi[standard]`), once the proxy has served that parent's metadata: if
an extra's packages are still refused with `403 wardby_package_not_allowed`,
name the extra on the allowlist directly (`uvicorn[standard]`). Every
safeguard still applies to what an extra adds. Extras need the coding proxy
and control plane on the same Wardby version: a proxy from before extras
support cannot load an allowlist with a `name[extra]` entry, so every registry
request of that run fails; and once a profile stores an extras entry, do not
downgrade below the release that added extras.

The quickstart's coding step offers the packages a local repository declares
(`package.json`, `pyproject.toml` including its build-system packages,
`requirements*.txt`, keeping Python extras such as `psycopg[binary]`) as
`local-builder`'s allowlist after asking, or with `--allow-repo-packages` in a non-interactive
run. See [Local repositories](local-repositories.md).

> Re-running the quickstart replaces `local-builder`'s package allowlist with
> what the repository declares (or empties it), discarding any packages you
> added with `update_agent`; re-add them after a re-run.

Review agents see the pull request's CI results in `repo_pr_read` and are
told to trust CI over the sandbox's **Tests**.

Read [`docs/coding-packages.md`](../docs/coding-packages.md) for allowlist
syntax (including [PyPI extras](../docs/coding-packages.md#pypi-extras)), package-policy controls, lockfile behavior, and refusal errors.
