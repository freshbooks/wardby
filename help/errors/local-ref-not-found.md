---
id: errors/local-ref-not-found
title: Git branch or ref does not exist in the local repository
summary: A branch or base ref the run asked for was not found in the repository history.
audience: operator
tags: [error, local-repositories, coding-agents, vcs]
appliesTo: ">=0.5.0"
---

# Git branch or ref does not exist in the local repository

`local_ref_not_found` means a branch, base or other ref named in a request does
not resolve to a commit in the local repository. It comes from:

- a coding run whose `baseRef` (on the agent's profile or in `trigger_agent`)
  is not a branch of the repository;
- a continuation or a `baseRef: wardby/run-<run id>` whose result branch was
  deleted, for example with `git branch -D`; or
- a review (`trigger_agent` with `review`) whose `branch` or `base` is not a
  branch of the repository, or a file read at a ref that does not exist.

Only committed history counts. Uncommitted changes are not part of any branch.

## What to do

1. List the branches the repository really has:
   ```
   git -C /path/to/repo branch --all
   ```
2. Fix the name, or commit your work to a branch first:
   ```
   git switch -c my-branch
   git commit -am "Work in progress"
   ```
3. If a result branch was deleted and you still have its commit, recreate it
   with `git branch wardby/run-<run id> <commit>`. Otherwise start from another
   branch.
4. For a review, check both `branch` and `base`; `base` defaults to the branch
   checked out in the repository.

Related: [Local git repositories](../local-repositories.md).
