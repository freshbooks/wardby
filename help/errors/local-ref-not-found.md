---
id: errors/local-ref-not-found
title: Git branch or ref does not exist in the local repository
summary: A branch or base ref the run asked for was not found in the repository history.
audience: operator
tags: [error, local-repositories, coding-agents, vcs]
appliesTo: ">=0.5.0"
---

# Git branch or ref does not exist in the local repository

A run using a local repository failed because a branch or ref it needed does
not exist in that repository. This can happen when:

- A coding run asks to start from a branch (e.g., `branch: feature-x`) that
  has been deleted or does not exist yet.
- A review agent is asked to review a branch against a base branch, and either
  the branch or the base branch is not found.
- A run asks to reuse an existing branch (e.g., a continuation), but that
  branch has been deleted since the prior run.

Only committed history is visible to wardby. Uncommitted changes in a working
directory are not part of the branch.

## What to do

1. **Check which branches exist:**
   ```
   cd /path/to/repo && git branch -a
   ```
   This lists local and remote-tracking branches.

2. **If the branch needs to be created:**
   - Create and commit to the branch locally first:
     ```
     git checkout -b branch-name
     # make changes, then:
     git add .
     git commit -m "Initial commit"
     ```
   - Then re-run the wardby request with the new branch name.

3. **If the branch was deleted:**
   - If you still have the commit hash, you can recreate it:
     ```
     git branch branch-name <commit-hash>
     ```
   - Otherwise, ask the run to start from the current default branch instead,
     or from another branch that still exists.

4. **For review requests:**
   - Verify both the feature branch and the base branch exist and are spelled
     correctly:
     ```
     git show origin/feature-branch
     git show origin/main
     ```
   - If using a local repository, both branches must have commits; they cannot
     be created as part of the run.

Related: [Local git repositories](../local-repositories.md).
