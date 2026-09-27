---
id: errors/protected-path
title: Run changed a protected path
summary: A coding run's changes touched a path this agent may not edit, so none of its changes were kept.
audience: operator
tags: [error, coding-agents, vcs]
appliesTo: >=0.2.1
---

# Run changed a protected path

A run that failed with category `protected_path` finished its work, but the
changes it collected included a file its agent is not allowed to edit. Wardby
discards the run's changes entirely rather than dropping just that file:
nothing from the run reaches a pull request.

Wardby protects two kinds of paths on every coding run:

- **The agent's own `protectedPaths`**, a list of glob patterns set on the
  agent (`codingProfile.protectedPaths`, via `create_agent`/`update_agent`).
  An entry may start with `!` to carve out one literal file as an exception
  to the agent's own patterns; a whole tree can never be carved out this way.
- **The `.wardby/` baseline**, which every coding run gets regardless of the
  agent's own settings. It protects everything under `.wardby/` except the one
  literal file `.wardby/services.yaml`, which any coding agent may propose a
  change to (see [Coding services](../coding-services.md)) — the baseline
  cannot be widened to cover that file, and no exception can narrow it further
  than that.

What to do:

1. Ask again without changing the named file. If the change is small, doing it
   yourself and letting the agent build on top is often fastest.
2. If the agent genuinely needs to change that file, its owner (or an admin)
   can widen `codingProfile.protectedPaths` with `update_agent` — for example
   adding a `!`-prefixed exception for one file. This can never remove the
   `.wardby/` baseline itself.
3. Otherwise, the repository owner makes the change directly and the agent
   works around it on the next run.

When this run is a sub-run another agent dispatched (for example a router
handing work to a coding agent), the parent sees a failed sub-run on its own
status comment: "A sub-run could not open its changes: it changed a file its
agent may not edit, so none of its changes were kept." That line never names
the file; check the sub-run's own PR comment or `get_run` for it.
