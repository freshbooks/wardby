---
id: errors/local-path-invalid
title: Invalid file path in local repository read
summary: A file path given to a repository read was absolute or contained unsafe path segments.
audience: operator
tags: [error, local-repositories, coding-agents, vcs]
appliesTo: ">=0.5.0"
---

# Invalid file path in local repository read

A run using a local repository failed because it tried to read a file using
an invalid path. Wardby only allows repository-relative paths — paths that
stay within the repository and do not escape it. Absolute paths and paths
containing unsafe segments like `..` are rejected for security.

This can happen when:

- A run tries to read a file by its absolute path instead of a path relative
  to the repository root.
- A file path includes `..` (parent directory references), which could escape
  the repository.
- A file path contains empty segments (e.g., `folder//file.txt`).
- A run tries to read a symlink that points outside the repository.

## What to do

Always use repository-relative paths when reading from a local repository:

**Incorrect (absolute paths):**
```
/home/user/projects/my-repo/src/main.ts
/var/repos/myapp/README.md
```

**Correct (repository-relative paths):**
```
src/main.ts
README.md
docs/guide/setup.md
src/../main.ts  ← also incorrect (contains ..)
```

**Incorrect (containing .. or empty segments):**
```
src/../docs/README.md  (contains ..)
src//main.ts  (empty segment)
./././main.ts  (redundant segments)
```

**Correct (clean, relative paths):**
```
src/main.ts
docs/README.md
```

If you need to read a file that is reachable via symlinks, the symlink's
final target must stay within the repository folder. Symlinks that point
outside the repository are not allowed.

Related: [Local git repositories](../local-repositories.md).
