---
id: errors/local-ref-invalid
title: Invalid git branch or ref name
summary: A branch or ref name was rejected because it does not follow git's naming rules.
audience: operator
tags: [error, local-repositories, coding-agents, vcs]
appliesTo: ">=0.5.0"
---

# Invalid git branch or ref name

`local_ref_invalid` means wardby refused a branch or ref name before passing it
to git. A name is rejected when it:

- is empty, starts with `-`, or contains `@{`, a NUL, a space or other
  non-printable or non-ASCII character;
- is too long; or
- is not accepted by `git check-ref-format --branch` (for example it contains
  `..`, a trailing `.lock`, or characters such as `~`, `^`, `:` or `\`).

It can also appear when a review is requested without `base` while the
repository's HEAD is detached, because there is no checked-out branch to use.

## What to do

Use a plain branch name that git accepts. You can check one with:

```
git check-ref-format --branch my-branch-name
```

Valid examples: `feature/add-login`, `fix-123`, `release-1.0`. Invalid examples:
`-feature`, `feature branch`, `feature..fix`. For the detached HEAD case, pass
`review.base` explicitly or check out a branch.

Related: [Local git repositories](../local-repositories.md).
