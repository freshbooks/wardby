---
id: errors/package-refusals
title: Package registry refused an install
summary: Understand package refusal codes and unblock a coding run's blocked status.
audience: operator
tags: [error, packages, allowlist, wardby_graph_incomplete, wardby_graph_limit, wardby_package_not_allowed, wardby_version_filtered]
appliesTo: >=0.2.1
---

# Package registry refused an install

A coding run can finish successfully after restoring its changes because a
needed package was refused. When no pull request or pushed changes result,
the parent status says ⛔ **Blocked by the package registry: no changes were
made.** With a pull request, the link stays and a ⚠️ warning lists refusals.

- `wardby_package_not_allowed`, `wardby_graph_incomplete`, and
  `wardby_graph_limit`: add the needed package to the coding agent's
  `codingProfile.packageAllowlist` with `update_agent`.
- `wardby_version_filtered`: no version passed the release-age, advisory, or
  malware checks. For release age, wait or adjust
  `codingProfile.packagePolicy.minReleaseAgeDays`. For an advisory, upgrade
  to a safe version or accept the advisory after reviewing exposure using
  `codingProfile.packagePolicy.acceptedAdvisories`. Malware is never waivable:
  use a safe alternative, never bypass the malware check. The code alone
  does not distinguish which check blocked the version.
- Other codes: inspect the registry error and package policy before retrying.

Changing allowlists or policy needs `packages:approve` or `agents:admin`.
`update_agent` replaces the whole package policy, so send all intended fields.
After fixing the refusal, mention `@wardby` again. An existing run's package
policy does not change.

See [Approve packages for coding agents](../coding-packages.md) and
[Run status comments](../status-comments.md).
