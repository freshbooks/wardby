---
id: errors/model-unavailable
title: Model not available
summary: Wardby refused to start or configure a run because its model is not usable in this deployment right now.
audience: all
tags: [error, models, pricing, model_unavailable, refusal]
appliesTo: ">=0.4.0"
---

# Model not available

`model_unavailable` means the model an agent names cannot be routed to in
this deployment right now. Wardby checks this before a run starts spending —
and whenever `create_agent` or `update_agent` sets or changes an agent's
model — never mid-run. A native agent's error carries one of three reasons;
a coding agent's only ever carries the first two, since a coding run uses the
coding proxy's own credentials rather than looking up a provider adapter:

- **`not_in_catalog`** — the model id is not in the catalog at all: not
  shipped with this release, and no admin has added it. Run `list_models` to
  see the exact ids this deployment knows about, and pick one of those, or
  ask someone with `models:admin` to add it with `set_model`.
- **`disabled`** — the model is in the catalog, but an admin has disabled it
  with `disable_model`. Pick a different model, or ask someone with
  `models:admin` to bring it back with `reset_model` (reverts to the shipped
  entry, if any) or `set_model` (re-adds it with current values).
- **`provider_not_configured`** (native agents only) — the model's provider
  (`openai`, `anthropic`, or `bedrock-claude`) has no credentials configured
  for native runs in this deployment, even though the model itself is in the
  catalog. An operator needs to configure that provider's credentials before
  any native agent can use a model under it; see
  [Getting started](../getting-started.md).

A coding agent's model is checked against the catalog only
(`not_in_catalog`/`disabled`), never `provider_not_configured`: coding runs
never look up a provider adapter at all, so a model can pass this check and
still fail later for reasons `model_unavailable` never reports.

One such failure has a specific name: dispatching a Claude Code run throws
`coding_provider_not_configured:claude-code` when this deployment's
`CODING_CLAUDE_WORKER_IMAGE` or `CODING_CLAUDE_TOOL_RUNNER_IMAGE` isn't set —
it means the Claude Code worker or tool-runner image itself isn't configured,
not a missing credential, and there is no equivalent error or string for
Codex. See [Local coding-agent setup](../../docs/coding-agent-setup.md).

A missing or invalid API key behind a coding run's model-provider credential
(`CODING_OPENAI_CREDENTIAL_REF` for Codex, `CODING_ANTHROPIC_CREDENTIAL_REF`
for Claude Code) is a different problem with no dedicated error code
documented here: the run starts, then fails when it actually calls the
model — not as `model_unavailable`, and not at dispatch. Check the coding
proxy's own logs for that run.

See [Models and pricing](../models.md) for how the catalog works and who can
change it.
