---
id: agent-recipes
title: Agent recipes
summary: Two copyable agent setups, an architecture keeper and a per-language builder, with the version, GitHub App, and webhook prerequisites each needs.
audience: operator
tags: [recipes, examples, coding-agents, architecture, builder, router, mention, push, getting-started]
appliesTo: >=0.4.0
---

# Agent recipes

Two complete setups you can ask your MCP client to build:

- **Architecture keeper:** a scheduled architect coding agent, a merge watcher
  with the `push` trigger, and a reviewer step that uses `docs/knowledge/`.
- **Builder per language:** a native router linked with `mention` that delegates
  to a coding builder, with Node/TypeScript, Python (`node-python`), and
  bring-your-own-image (`workerImageRef`) variants.

They go beyond the quickstart, which runs native agents only. They require
Wardby 0.4.0 or later, the GitHub App, worker image, and job launcher from
coding-agent setup, and, for the `push`, `pull_request`, and `mention` triggers,
a public HTTPS URL where GitHub can deliver webhooks.

Read the full recipes, with the asks, configurations, and prompts, in
[`docs/agent-recipes.md`](../docs/agent-recipes.md).

Related: [Set up an architecture agent](help://architecture-agent),
[Architecture knowledge bundles](help://knowledge),
[Choose a native or coding agent](help://creating-agents),
[Connect GitHub repositories](help://github-integration),
[Run GitHub code-review agents](help://code-review-agents),
[Approve packages for coding agents](help://coding-packages), and
[Services for coding runs](help://coding-services).
