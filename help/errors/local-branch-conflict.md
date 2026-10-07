---
id: errors/local-branch-conflict
title: Run's branch was modified while the run was working
summary: The branch wardby/run-<id> changed while the run was in progress, or it is currently checked out.
audience: operator
tags: [error, local-repositories, coding-agents, vcs]
appliesTo: ">=0.5.0"
---

# Run's branch was modified while the run was working

A run using a local repository failed because its working branch was modified
or is in use while the run was still working. Wardby creates a temporary branch
`wardby/run-<id>` for each run, and that branch must remain stable until the
run completes and commits its work.

This error occurs when:

- Someone committed or pushed to the `wardby/run-<id>` branch while the run
  was working, causing the branch pointer to move.
- The `wardby/run-<id>` branch is currently checked out in the repository's
  working directory, which prevents wardby from updating it.

The run's commit is not pushed to any branch, so no work is lost — but the run
is abandoned because the branch state is no longer reliable.

## What to do

1. **Check what branch is currently checked out:**
   ```
   cd /path/to/repo && git status
   ```

2. **If the `wardby/run-<id>` branch is checked out:**
   - Switch to a different branch:
     ```
     git checkout main
     ```
   - Then re-run the wardby request. The run will create a fresh `wardby/run-<id>`
     branch.

3. **If someone else committed to the run's branch:**
   - This should not happen in normal operation. Check who has write access to
     the repository and ensure only the wardby server (and you manually) are
     making changes while a run is in progress.
   - Re-run the wardby request — the run will use a new `wardby/run-<id>`
     branch with a different run ID.

4. **Prevent this in the future:**
   - Do not manually push to branches named `wardby/run-*` while runs are
     working.
   - Do not checkout a `wardby/run-*` branch in your working directory.
   - If you need to inspect a run's work, use `git show wardby/run-<id>` or
     create a temporary branch from it instead.

Related: [Local git repositories](../local-repositories.md).
