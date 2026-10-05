---
id: errors/continuation-closed
title: Continuation's pull request is no longer open
summary: A run asked to continue a pull request that was already merged or closed, so nothing was pushed.
audience: operator
tags: [error, coding-agents, vcs, pull-requests, continuation, continuePriorRun]
appliesTo: ">=0.4.2"
---

# Continuation's pull request is no longer open

A coding run started with `continuePriorRun` (a mention follow-up, a Jira
issue-event task, or a review fix round) reuses the branch and pull request
the named run originally opened. Before cloning, and again right before it
pushes, wardby asks GitHub whether that pull request is still open. A run
that failed with category `continuation_closed` found a definite answer that
it is not: the pull request was merged or closed, or GitHub no longer lists
an open pull request carrying that run's marker for the branch. Nothing from
the run was pushed either way, so the pull request (and anyone who merged or
closed it) is unaffected.

This is a safety check, not a flaky one: a transient GitHub failure while
checking (a timeout, a rate limit, a 5xx) is retried once and, if it still
fails, wardby proceeds as though the pull request were still open rather
than failing the run on an unconfirmed answer — it only ever refuses on a
definite "merged", "closed", or "no longer found" answer.

What the requester sees:

- A mention follow-up or Jira issue-event task gets back: "The pull request
  this run was asked to continue is no longer open (merged or closed), so
  nothing was pushed. If the change is still needed, delegate again without
  continuePriorRun: it becomes a new pull request from the default branch."
- A parent agent that delegated the continuation sees the same sentence as
  its sub-run's `refusal`, never the raw error code.
- An @-mention's status comment reads: "A sub-run was asked to continue a
  pull request that is no longer open (merged or closed); nothing was
  pushed."

What to do: if the change is still needed, ask again without
`continuePriorRun` (or without naming the closed pull request). The new run
opens a fresh pull request from the repository's default branch.

Related: [Run GitHub code-review agents](../code-review-agents.md),
[Automatic review fix rounds](../review-fix-rounds.md).
