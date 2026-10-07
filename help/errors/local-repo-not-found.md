---
id: errors/local-repo-not-found
title: Local repository path not found or not a git repository
summary: The repository path does not exist, is not a git work tree, or is not visible to the wardby server.
audience: operator
tags: [error, local-repositories, coding-agents, vcs]
appliesTo: ">=0.5.0"
---

# Local repository path not found or not a git repository

A run using a local repository (a path starting with `local:`) failed because
the path either does not exist, is not the root of a git work tree, or is not
accessible to the wardby server. Local repositories only work when the wardby
server runs on the same machine as the repository itself — not inside a
container or Kubernetes cluster.

Wardby checks for these conditions:

- **Path does not exist:** The folder at the given path has been deleted or
  moved.
- **Not a git work tree:** The path exists but is not the root of a git
  repository (no `.git/` directory).
- **Not visible to the server:** The wardby server process cannot access the
  path due to file-system permissions, or the server is running remotely
  (inside Docker, Kubernetes, or another machine) and cannot reach the local
  file system.

## What to do

1. **Verify the path exists and is a git repository:**
   ```
   ls -la /path/to/repo/.git
   cd /path/to/repo && git status
   ```
   If these commands fail, the path is not a valid git work tree.

2. **Ensure the wardby server can see the path:**
   - If wardby runs locally (on your development machine), verify the folder
     is readable by the server process.
   - If wardby runs in Docker or Kubernetes, local repositories are not
     supported in that deployment. You must use a remote repository (GitHub,
     GitLab, etc.) or run wardby locally on the machine with the repository.

3. **Check file-system permissions:**
   - Verify the wardby server has read access to the repository:
     ```
     ls -ld /path/to/repo
     ```
   - If needed, adjust permissions so the server's user can read the folder.

Related: [Local git repositories](../local-repositories.md).
