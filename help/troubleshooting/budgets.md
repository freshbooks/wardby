---
id: troubleshooting/budgets
title: Troubleshoot budgets and reservations
summary: Diagnose run refusals caused by an exhausted agent, shared budget group, or sub-agent run tree.
audience: operator
tags: [budgets, reservations, refusals, scheduling]
appliesTo: >=0.2.1
---

# Troubleshoot budgets and reservations

Wardby reserves budget when it dispatches a run. The reservation is limited by
the agent's `budgetUsd`, the remaining shared daily, weekly, or monthly budget
group capacity, and the remaining parent run-tree capacity for a sub-agent.

When no capacity remains, Wardby records the run as refused and does not start
a worker. Common errors include `budget_group_exhausted:day`,
`budget_group_exhausted:week`, `budget_group_exhausted:month`, and
`run_tree_exhausted`.

Inspect the agent, its budget group, and recent runs before increasing a limit.
In-progress runs retain their unspent reservation, so overlapping scheduled,
webhook, and manual runs share one cap rather than each assuming the full
remaining balance.

For a shared-group refusal, read [Budget group exhausted](../errors/budget-group-exhausted.md).
