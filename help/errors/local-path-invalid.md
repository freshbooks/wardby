---
id: errors/local-path-invalid
title: Invalid file path in local repository read
summary: A file path given to a repository read was absolute or contained empty, dot or dot-dot segments.
audience: operator
tags: [error, local-repositories, coding-agents, vcs]
appliesTo: ">=0.5.0"
---

# Invalid file path in local repository read

`local_path_invalid` means a read of a file in a local repository (for example
`repo_read_file` in a review, or wardby reading `.wardby/services.yaml`) used a
path wardby will not pass to git. Paths must be relative to the repository root.
A path is rejected when it:

- starts with `/`;
- contains an empty segment (`src//main.ts`), a `.` segment or a `..` segment; or
- is empty or contains a NUL.

Wardby reads files from the committed tree at a ref, so only regular files are
readable. A symlink, directory or submodule at that path is not.

## What to do

Use a clean repository-relative path, such as `src/main.ts` or `docs/README.md`,
not `/home/you/repo/src/main.ts`, `./src/main.ts` or `src/../src/main.ts`. Use
`repo_list_files` to see what exists at the ref.

Related: [Local git repositories](../local-repositories.md).
