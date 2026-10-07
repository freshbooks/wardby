---
id: errors/local-repo-not-found
title: Local repository path not found or not a git repository
summary: The repository path does not exist, is not the top level of a git work tree, or is not visible to the wardby server.
audience: operator
tags: [error, local-repositories, coding-agents, vcs]
appliesTo: ">=0.5.0"
---

# Local repository path not found or not a git repository

`local_repo_not_found` means wardby could not use a local repository (written
`local:/absolute/path`) even though the path is inside a trusted folder. One of
these is true:

- the path does not exist (it was moved or deleted);
- the path is not the top level of a git work tree (it is a subfolder of a
  repository, a bare repository, or not a repository at all); or
- the wardby server cannot see the path: it runs in a container, a pod or on
  another machine, or its user cannot read the folder.

Local repositories need the wardby server to run on the same machine as the
folders, outside a container.

## What to do

1. Check the path from the machine that runs the wardby server:
   ```
   git -C /path/to/repo rev-parse --show-toplevel
   ```
   The output must be the path you gave wardby (after symlinks). If it is a
   parent folder, use that folder instead.
2. Make sure the server's user can read the folder.
3. If wardby runs in Docker or Kubernetes, run it directly on the machine with
   the repository, or use a GitHub repository instead.

Related: [Local git repositories](../local-repositories.md).
