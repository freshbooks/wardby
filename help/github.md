---
id: github-integration
title: Connect GitHub repositories
summary: Authorize repository access and configure Wardby coding or review agents through a scoped GitHub App.
audience: operator
tags: [github, repositories, coding-agents, code-review]
appliesTo: >=0.2.1
---

# Connect GitHub repositories

Wardby uses a GitHub App installed only on the repositories an agent may use.
Repository access is checked against the agent owner's linked GitHub account,
or an explicitly recorded administrator approval. Coding agents need write
access because they can push a branch and open a draft pull request.

Wardby rechecks access before preparing a coding workspace and again before
pushing. Losing access, unlinking the account, or a failed access check stops
the run without publishing changes. See [Repository-access troubleshooting](troubleshooting/repository-access.md)
for the resulting refusal states.

Workers do not receive the GitHub App private key. A trusted component validates
the changes, pushes a controlled branch, and opens at most one draft pull
request. Wardby does not auto-merge coding-agent output.

Read [`docs/coding-agent-setup.md`](../docs/coding-agent-setup.md) for coding
agent setup and [`docs/code-review-agents.md`](../docs/code-review-agents.md)
for pull-request review agents and webhook configuration.
Use [Run GitHub code-review agents](code-review-agents.md) for the operator
overview of checks, mentions, and fork limitations.

For Jira Cloud instead of GitHub, see [Run Jira agents](jira.md).
