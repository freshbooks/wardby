---
id: errors/package-refusals
title: Package registry refused an install
summary: Understand package refusal codes and unblock a coding run's blocked status.
audience: operator
tags: [error, packages, allowlist, wardby_graph_incomplete, wardby_graph_limit, wardby_package_not_allowed, wardby_package_not_allowed_pending, wardby_version_filtered, wardby_lockfile_entry_unsupported]
appliesTo: >=0.2.1
---

# Package registry refused an install

A coding run can finish successfully after restoring its changes because a
needed package was refused. When no pull request or pushed changes result,
the parent status says ⛔ **Blocked by the package registry: no changes were
made.** With a pull request, the link stays and a ⚠️ warning lists refusals.

- `wardby_package_not_allowed`, `wardby_package_not_allowed_pending`, and
  `wardby_graph_limit`: add the needed package to the coding agent's
  `codingProfile.packageAllowlist` with `update_agent`.
- `wardby_graph_incomplete`, `wardby_upstream_error`,
  `wardby_upstream_unavailable`, `wardby_audit_unavailable`, and
  `wardby_download_idle`: the registry could not finish checking the package,
  usually because an upstream was slow or failing. Mention `@wardby` again to
  retry.
- `wardby_version_filtered`: no version passed the release-age, advisory, or
  malware checks. For release age, wait or adjust
  `codingProfile.packagePolicy.minReleaseAgeDays`. For an advisory, upgrade
  to a safe version or accept the advisory after reviewing exposure using
  `codingProfile.packagePolicy.acceptedAdvisories`. Malware is never waivable:
  use a safe alternative, never bypass the malware check. The code alone
  does not distinguish which check blocked the version.
- `wardby_lockfile_entry_unsupported`: the lock file installs the package
  from git or a URL, which the registry cannot verify. Depend on a registry
  version instead.
- Other codes: inspect the registry error and package policy before retrying.

Changing allowlists or policy needs `packages:approve` or `agents:admin`.
`update_agent` replaces the whole package policy, so send all intended fields.
After fixing the refusal, mention `@wardby` again. An existing run's package
policy does not change.

See [Approve packages for coding agents](../coding-packages.md) and
[Run status comments](../status-comments.md).
