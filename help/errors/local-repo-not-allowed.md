---
id: errors/local-repo-not-allowed
title: Local repository is not in a trusted folder
summary: The repository path is outside every folder listed in LOCAL_REPO_ROOTS, so the run was refused.
audience: operator
tags: [error, local-repositories, coding-agents, vcs]
appliesTo: ">=0.5.0"
---

# Local repository is not in a trusted folder

A run using a local repository (a path starting with `local:`) was refused
because the repository's real path (after resolving symlinks) is not inside
any folder listed in the `LOCAL_REPO_ROOTS` environment variable. Wardby
requires local repositories to live inside explicitly trusted folders to
prevent accidental access to sensitive directories on the server machine.

`LOCAL_REPO_ROOTS` is a colon-delimited list (`:` on macOS and Linux; `;`
on Windows) of absolute paths. Every local repository must resolve (after
symlink resolution) to a path that starts with one of these trusted folders.
If the variable is unset, no local repositories are allowed.

## What to do

1. **Add the repository's folder to `LOCAL_REPO_ROOTS`:**
   - On macOS/Linux, append (or prepend) the folder's absolute path to the
     environment variable, separated by `:`. For example:
     ```
     LOCAL_REPO_ROOTS=/home/user/projects:/var/repos
     ```
   - On Windows, use `;` as the separator instead.
   - Restart the wardby server after editing the variable so it reads the
     new value.

2. **Or run the quickstart again:**
   - Run `npx @wardby/cli quickstart coding` (the coding setup step) to
     re-prompt for trusted folders. This saves them to your configuration,
     and the server reads them at startup.

Paths are compared after resolving all symlinks. If you use a symlink to
point to the repository, verify that the **real path** (the target it
resolves to) is inside a trusted folder, not the symlink's path itself.

Related: [Local git repositories](../local-repositories.md), [Getting started](../getting-started.md).
