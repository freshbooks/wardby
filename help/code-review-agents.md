---
id: code-review-agents
title: Run GitHub code-review agents
summary: Link a read-only review agent to a repository for pull-request checks and trusted mention workflows.
audience: operator
tags: [github, code-review, pull-requests, webhooks]
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

Wardby skips pull requests whose head is in a fork. It also ignores mentions
from bots and people without write access. Repository links require the
agent owner's linked GitHub access, or an explicitly recorded administrator
approval.

For App permissions, webhook setup, trigger configuration, and security
details, follow [`docs/code-review-agents.md`](../docs/code-review-agents.md).
