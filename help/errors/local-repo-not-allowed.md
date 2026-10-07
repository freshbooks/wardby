---
id: errors/local-repo-not-allowed
title: Local repository is not in a trusted folder
summary: The repository path is outside every folder listed in LOCAL_REPO_ROOTS, so the run was refused.
audience: operator
tags: [error, local-repositories, coding-agents, vcs]
appliesTo: ">=0.5.0"
---

# Local repository is not in a trusted folder

`local_repo_not_allowed` means wardby refused a local repository (a repository
written `local:/absolute/path`) because its real path, after resolving symlinks,
is not at or below any folder listed in the `LOCAL_REPO_ROOTS` environment
variable. If `LOCAL_REPO_ROOTS` is unset, no local repository is allowed.

A trusted folder that does not exist where the wardby server runs is ignored.
This is the usual cause when the server runs in a container, a pod or on
another machine: it cannot see the folder, so every repository under it is
refused with this error. `doctor` lists each trusted folder and reports a
missing one.

Wardby checks the folders when you create or update an agent, link a
repository, trigger a run, and again while a run uses the repository, so a
narrowed list also refuses agents that were saved earlier.

## What to do

1. Add the repository's folder (or a parent folder) to `LOCAL_REPO_ROOTS` on the
   wardby server. Separate folders with the platform's path delimiter: `:` on
   macOS and Linux, `;` on Windows. For example:
   ```
   LOCAL_REPO_ROOTS=/home/you/projects:/srv/repos
   ```
2. Restart the wardby server so it reads the new value.
3. If you set up wardby with `quickstart`, run it again with
   `--coding --trust /path/to/folder` (repeat `--trust` for more folders). It
   keeps the folders already trusted and writes the new list to `.wardby/.env`.

4. Run the wardby server directly on the machine that holds the folders, not
   in a container.

If the repository path goes through a symlink, the symlink's target must be
inside a trusted folder; the link's own location does not count.

Related: [Local git repositories](../local-repositories.md), [Get started](../getting-started.md).
