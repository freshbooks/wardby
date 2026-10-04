---
id: errors/coding-turn-limit
title: Coding run reached its turn limit
summary: A Claude Code coding run stopped because it used every agent turn its codingProfile.maxTurns allows (200 by default), before it finished the task.
audience: operator
tags: [error, coding-agents, claude-code, turns, maxTurns]
appliesTo: ">=0.4.2"
---

# Coding run reached its turn limit

`coding_turn_limit` (failure category `turn_limit`) means a Claude Code run used
all of its agent turns before it finished. Every file read, command and edit is
a turn. The limit is the agent's `codingProfile.maxTurns`, or 200 when it is
unset. Codex runs have no turn limit.

1. Read the run's summary, and its debug trace if one was on
   (`codingProfile.debugTraceMinutes`), to see whether the task was large or the
   agent was repeating itself.
2. For a large task, raise the limit (1 to 1000) with `update_agent`:
   `{ "id": "<agent id>", "codingProfile": { "maxTurns": 400 } }`.
3. For a loop, narrow the task or fix what it was retrying, then run it again.

The run's `budgetUsd` and `timeoutSec` still apply. See
[Troubleshoot coding workers](../troubleshooting/coding-workers.md).
