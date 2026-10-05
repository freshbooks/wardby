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

## Events and triggers

Link a native agent to a repository with `link_repository`. Each trigger needs
its GitHub App event ticked in the App's event settings; every event is a
separate checkbox.

| Trigger        | Starts a run when                                                                                                   | App event to subscribe                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `pull_request` | A pull request is opened or pushed to; a re-run of the review check; CI finishing after a review that waited for it | Pull request, Check run (re-runs of the review check), Check suite (CI finishing)      |
| `mention`      | Someone with write access `@`-mentions the App                                                                      | Issue comment, Issues, Pull request review comment (mentions in inline review threads) |
| `push`         | A commit lands on the repository's default branch                                                                   | Push                                                                                   |
| `review_fix`   | Wardby's own review check requests changes on a PR it opened                                                        | Same events as `pull_request` (it reacts to that check's own verdict, no extra event)  |

The `push` trigger starts a merge-watcher agent; only default-branch pushes
count (tags, other branches, and deletions are ignored). See
[Keep the knowledge bundle current on merge](help://architecture-agent).

The `review_fix` trigger lets Wardby fix its own review's findings
automatically, up to a round cap, on pull requests its own coding runs
opened. See [Automatic review fix rounds](review-fix-rounds.md).

For Jira Cloud instead of GitHub, see [Run Jira agents](jira.md).
