---
id: creating-agents
title: Choose a native or coding agent
summary: Decide whether a task should run as a native Wardby agent or an isolated Codex or Claude Code coding agent.
audience: developer
tags: [agents, native-agents, coding-agents, codex, claude-code]
appliesTo: >=0.2.1
---

# Choose a native or coding agent

Create a **native agent** when Wardby should run a model with explicit,
attached capabilities to produce a bounded operational result. Create a
**coding agent** when the task must inspect and change a Git repository, run
project checks, and optionally open a draft pull request.

| Choose       | Best for                                                                             | Execution model                                                                                    | Typical result                                                     |
| ------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Native agent | Review, triage, analysis, reporting, workflow coordination, and API-backed tasks     | Wardby's managed native run loop with only its attached tools, secrets, datastores, and sub-agents | A structured result, report, decision, or bounded follow-up action |
| Coding agent | Repository changes, tests, dependency updates, implementation work, and PR revisions | An isolated Codex or Claude Code worker with a trusted proxy and Git finalization                  | No changes, a bounded result, or one controlled draft pull request |

## Start with a native agent

Native agents are the default when a task does not need a full repository
workspace. Give the agent a narrow purpose, model, per-run budget, and only the
tools or data it needs. Attach schedules or webhooks when the work should run
without a person starting it manually.

Examples include an architecture reviewer that writes findings to a datastore,
a release monitor that investigates an alert, or a triage agent that turns
incoming information into a report for a person to act on.

## Use a coding agent for repository work

Coding agents use a `codingProfile` that selects Codex or Claude Code and names
the authorized repository. They run in isolated workers; Wardby keeps provider
credentials and the GitHub App private key in trusted components. A coding run
can change a checkout and run approved checks, but trusted finalization is what
validates the result, pushes a controlled branch, and opens a draft pull
request. It never auto-merges.

Before creating one, configure immutable worker images, the selected launcher,
the trusted coding proxy, and a narrowly installed GitHub App. The agent owner
must have the required repository access, or an administrator must explicitly
approve the repository.

## Choosing a model

Both agent types take a `model` field naming an entry in wardby's model
catalog. Run `list_models` to see which ids this deployment can actually
route to right now (`routable: true`) and what each costs; `get_model` shows
one entry in full. `create_agent` and `update_agent` refuse a `model` that
isn't in the catalog, is disabled, or whose provider has no credentials
configured here. See [Models and pricing](models.md).

## Decision checklist

Choose a native agent when all of these are true:

- The task can be completed with a narrow set of attached tools or data.
- A repository checkout, shell-based project setup, and code changes are not
  required.
- The intended output is an analysis, report, decision, or controlled API
  action.

Choose a coding agent when any of these are true:

- The agent must edit a repository or execute the project's test suite.
- The reviewable outcome should be a branch or draft pull request.
- The task needs a coding-agent builder such as Codex or Claude Code inside an
  isolated workspace.

Do not use a coding agent merely because a task is complex. Start with the
least powerful execution model that can safely produce the required outcome.
Read [Connect GitHub repositories](github.md) and
[Troubleshoot coding workers](troubleshooting/coding-workers.md) before
enabling repository-changing work.
