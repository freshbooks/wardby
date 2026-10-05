---
id: code-review-agents
title: Run GitHub code-review agents
summary: Link a read-only review agent to a repository for pull-request checks and trusted mention workflows.
audience: operator
tags: [github, code-review, pull-requests, webhooks, ci, checks]
appliesTo: >=0.2.1
---

# Run GitHub code-review agents

A native agent linked through Wardby's GitHub App can review pull requests
without receiving repository credentials. On pull-request pushes it creates an
in-progress check, reads the diff, then posts inline findings, one updated
summary comment, and a final approve, changes-requested, or comment result.
Budget exhaustion or another failed review makes the check fail rather than
silently pass branch protection.

People with write access to the repository may request another review with
`@<app-slug> review`. Other mentions can be routed to a dedicated mention
agent, which acknowledges the request and posts its final outcome. Do not give
a mention agent instructions that could echo secrets or internal details: its
reply is visible wherever the mention was posted.

A mention on a pull request that a wardby coding run opened continues that
run's branch. If this deployment has no record of the run that opened it (for
example, another wardby deployment sharing the same GitHub App opened it), the
App replies that it cannot continue the pull request instead of starting a
run. Ask the deployment that opened it, or change the branch by hand. A
continuation also never pushes to a pull request that has since been merged
or closed — see
[Continuation's pull request is no longer open](errors/continuation-closed.md).

A repository can also be linked so wardby fixes its own review's findings on
such a pull request automatically, up to a round cap — see
[Automatic review fix rounds](review-fix-rounds.md).

Wardby skips pull requests whose head is in a fork. It also ignores mentions
from bots and people without write access. Repository links require the
agent owner's linked GitHub access, or an explicitly recorded administrator
approval.

## CI and sibling pull requests

`repo_pr_read` also returns `ci`: the CI check runs and commit statuses on the
pull request's head commit (Wardby's own checks left out), an overall state,
and a note. CI is the authority on whether the head builds and passes its
tests. The **Tests** list in a Wardby pull request's description was run in
Wardby's coding sandbox, which may have had an incomplete install (see the
**Dependency install incomplete** warning). Checks still running are reported
as pending; a review that started before CI finished is not repeated when CI
completes — use **Re-run** on the review check.

Commit statuses need the App's **Commit statuses: Read** permission; without
it only check runs are shown.

Add this to a reviewer's system prompt:

    Reviewer step (CI and related pull requests). Read `ci` from repo_pr_read.
    When `ci` and the description's Tests disagree, follow CI and say so; never
    ask for a fix only because a sandbox test failed while CI passed. Report
    pending checks as pending. If the description has a "Related pull requests"
    section, a field, route or schema the change relies on may be added by one
    of those pull requests: do not report it as missing; note the dependency
    and the suggested merge order instead.

Wardby also writes that section: see
[Related pull requests across repositories](related-pull-requests.md).

For App permissions, webhook setup, trigger configuration, and security
details, follow [`docs/code-review-agents.md`](../docs/code-review-agents.md).
