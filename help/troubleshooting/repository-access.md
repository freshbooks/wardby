---
id: troubleshooting/repository-access
title: Troubleshoot repository access
summary: Diagnose why Wardby refused repository work or could not verify the agent owner's GitHub access.
audience: operator
tags: [github, repositories, authorization, refusals]
appliesTo: >=0.2.1
---

# Troubleshoot repository access

Wardby checks that the owner of a coding or repository-linked agent has the
required current GitHub permission. A coding repository requires write access;
a read-only repository link requires read access. An administrator can record a
repository approval when no individual's access is appropriate.

`repo_access` means the current owner no longer has the required permission,
has unlinked their account, or the repository was not authorized. Restore the
owner's GitHub link and permission, or have an administrator review and record
the appropriate repository authorization.

`repo_access_unavailable` means Wardby could not verify GitHub access after its
retry. Do not treat it as permission granted: resolve the GitHub/API condition
and re-run the work later.

Read [Repository access refused](../errors/repo-access.md) for the safe
remediation sequence.
