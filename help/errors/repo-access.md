---
id: errors/repo-access
title: Repository access refused
summary: Wardby refused repository work because it could not confirm the managed agent owner's required GitHub access.
audience: operator
tags: [error, github, authorization, refusal]
appliesTo: >=0.2.1
---

# Repository access refused

`repo_access` means Wardby cannot authorize the agent owner's current access to
the selected repository. Nothing is cloned or pushed for a refusal at run
preparation. The check also happens immediately before a coding run pushes, so
access lost during a run prevents publication.

1. Confirm the agent has an owner and the intended repository is attached.
2. Confirm that owner has linked their GitHub account to Wardby.
3. Confirm the GitHub App is installed on the repository and the owner has the
   required permission: write for coding work, read for a read-only link.
4. If no individual owner can hold the access, ask a Wardby administrator to
   record an explicit repository approval.
5. Trigger a fresh run after the correction.

`repo_access_unavailable` is different: GitHub could not be queried reliably.
Resolve the availability condition and retry later rather than treating it as
an authorization success. See [Repository-access troubleshooting](../troubleshooting/repository-access.md).
