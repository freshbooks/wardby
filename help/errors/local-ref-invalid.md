---
id: errors/local-ref-invalid
title: Invalid git branch or ref name
summary: A branch or ref name was rejected because it does not follow git naming rules.
audience: operator
tags: [error, local-repositories, coding-agents, vcs]
appliesTo: ">=0.5.0"
---

# Invalid git branch or ref name

A run using a local repository failed because a branch or ref name it was given
is not a valid git name. Git has strict rules for branch and ref names — they
must not start with `-`, and they cannot contain certain characters like
spaces, control characters, or `..`.

This error typically occurs when:

- A run is asked to use a branch name that does not conform to git rules.
- A branch name is constructed dynamically (for example, from user input) and
  includes invalid characters.

## What to do

Use a plain, valid git branch name. Valid branch names:

- Contain only alphanumerics, hyphens, underscores, and slashes (`/`).
- Do not start with `-` or `.`.
- Do not contain `..` (double dots).
- Do not contain spaces.
- Do not contain special characters like `@`, `!`, or `#` (except in certain
  contexts like `refs/heads/`).

Examples of valid branch names:

- `feature/add-login`
- `fix-bug-123`
- `user_changes_v2`
- `release-1.0`

Examples of invalid branch names:

- `-feature` (starts with hyphen)
- `feature branch` (contains space)
- `feature..fix` (contains `..`)
- `.backup` (starts with dot)

If the branch name is constructed from user input or external data, sanitize
it to remove or replace invalid characters before passing it to wardby.

Related: [Local git repositories](../local-repositories.md).
