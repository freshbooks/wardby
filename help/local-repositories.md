---
id: local-repositories
title: Local git repositories
summary: Using local git repositories with wardby coding and review agents — setup, capabilities, and limitations.
audience: operator
tags: [local-repositories, coding-agents, review-agents, vcs]
appliesTo: ">=0.5.0"
---

# Local git repositories

Wardby supports local git repositories for coding and review agents, using
paths that start with `local:` followed by an absolute file-system path
(for example, `local:/home/user/projects/myapp`). This allows agents to
work directly on repositories on the same machine as the wardby server.

## Setup

Local repositories are allowed only inside folders listed in the
`LOCAL_REPO_ROOTS` environment variable. This is a colon-delimited list
(`:` on macOS and Linux, `;` on Windows) of absolute trusted folder paths.

You can set this variable:

1. **In your environment before starting wardby:**
   ```bash
   export LOCAL_REPO_ROOTS=/home/user/projects:/var/repos
   wardby start
   ```

2. **During the quickstart setup:**
   ```bash
   npx @wardby/cli quickstart coding
   ```
   The coding setup step will prompt you for trusted folders and save them
   to your configuration.

After adding folders to `LOCAL_REPO_ROOTS`, restart the wardby server so
it reads the new value.

## How coding agents use local repositories

When you dispatch a coding agent with `local:/path/to/repo`:

1. The server verifies the path is inside a trusted folder (after resolving
   symlinks).
2. The server clones (copies) the repository to a temporary working
   directory.
3. The agent works in that copy and commits changes to a temporary branch
   (`wardby/run-<id>`).
4. The run's commit is **not** pushed back to the original repository.

If you need to push the work back, fetch the branch and merge it manually:

```bash
cd /path/to/repo
git fetch origin wardby/run-<run-id>
git merge FETCH_HEAD
```

Or check out the branch and push it yourself:

```bash
git checkout wardby/run-<run-id>
git push origin wardby/run-<run-id>:my-feature
```

## How review agents use local repositories

A review agent can inspect branches in a local repository:

1. Provide the repository path (`local:/path/to/repo`).
2. Specify the branch to review and (optionally) the base branch.
3. The agent examines the differences and reports findings.

Both the branch and the base branch must exist as committed history. The
agent does not create branches or push changes.

## Limitations

- **Server locality:** The wardby server must run on the same machine as the
  repository. Local repositories do not work if wardby is running in a
  container, Kubernetes cluster, or on a different machine. Use remote
  repositories (GitHub, GitLab, etc.) for distributed setups.

- **Symlinks:** Paths are compared after resolving all symlinks. The
  **real path** (the symlink's target) must be inside a trusted folder, not
  the symlink's path itself.

- **No automatic push:** Coding runs do not push branches back to the
  repository. You must push manually, or configure a webhook to fetch and
  integrate the work.

- **File permissions:** The wardby server process must have read access to
  the repository folder. If the folder is owned by a different user or has
  restricted permissions, adjust permissions so the server can read it.

## Error handling

If a run encounters an error with a local repository, check:

- [Local repository is not in a trusted folder](errors/local-repo-not-allowed.md)
- [Local repository path not found or not a git repository](errors/local-repo-not-found.md)
- [Git branch or ref does not exist in the local repository](errors/local-ref-not-found.md)
- [Invalid git branch or ref name](errors/local-ref-invalid.md)
- [Invalid file path in local repository read](errors/local-path-invalid.md)
- [Run's branch was modified while the run was working](errors/local-branch-conflict.md)

See [Getting started](getting-started.md) for complete setup instructions.
