---
id: errors/coding-pypi-lockfile-unresolved
title: Coding run changed a uv.lock that still names the registry proxy
summary: A coding run added or upgraded a uv dependency, so its uv.lock holds download URLs that exist only inside the sandbox, and wardby did not collect the changes.
audience: operator
tags: [error, coding-agents, uv, lockfile, registry-proxy]
appliesTo: ">=0.4.2"
---

# Coding run changed a uv.lock that still names the registry proxy

`coding_pypi_lockfile_unresolved` means a coding run finished with changes, but
a `uv.lock` in the workspace names the registry proxy for a package the run
added or upgraded. During a run wardby points an existing `uv.lock` at the
proxy and puts the original URLs back before collecting the changes. It can
only restore URLs it saw before the agent started, so a new or upgraded
package keeps a sandbox-only URL. A pull request with that lock could not
install outside the sandbox, so the run fails instead of collecting it.

1. Add or upgrade the dependency in your own checkout (`uv add` or
   `uv lock --upgrade-package <name>`) and commit the resulting `uv.lock`.
2. Run the task again, or narrow it so the agent does not change dependencies.

Runs that leave the dependencies as they were, and projects without a
`uv.lock`, are not affected. See
[Troubleshoot coding workers](../troubleshooting/coding-workers.md).
