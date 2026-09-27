---
id: operating-agents
title: Operate managed agents
summary: Understand the identity, budget, capabilities, triggers, and result of a Wardby-managed agent.
audience: operator
tags: [agents, budgets, schedules, runs]
appliesTo: >=0.2.1
---

# Operate managed agents

Every Wardby-managed agent has an owner, system prompt, model, per-run budget,
and explicitly attached capabilities. A run starts only when its identity,
policy, and available budget agree.

Create, update, pause, trigger, and inspect agents through Wardby's MCP tools.
The CLI is the bootstrap and operations fallback. Scheduled work requires a
running scheduler: `wardby serve` runs MCP, scheduler, and reconciliation in
one process; `wardby mcp` alone does not execute schedules.

Use [Choose a native or coding agent](creating-agents.md) to select the least
powerful execution model that can safely produce the desired outcome.

Before a run starts, Wardby reserves its allowed spend. The reservation is
constrained by the agent's own budget, any shared budget group, and any
sub-agent run tree. See [Budget troubleshooting](troubleshooting/budgets.md)
when a run is refused for lack of budget.

For the full lifecycle and the controls applied to every managed run, read
[`README.md`](../README.md).
