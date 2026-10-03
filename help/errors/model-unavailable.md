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
model — never mid-run. The error carries one of three reasons:

- **`not_in_catalog`** — the model id is not in the catalog at all: not
  shipped with this release, and no admin has added it. Run `list_models` to
  see the exact ids this deployment knows about, and pick one of those, or
  ask someone with `models:admin` to add it with `set_model`.
- **`disabled`** — the model is in the catalog, but an admin has disabled it
  with `disable_model`. Pick a different model, or ask someone with
  `models:admin` to bring it back with `reset_model` (reverts to the shipped
  entry, if any) or `set_model` (re-adds it with current values).
- **`provider_not_configured`** — the model's provider (`openai`,
  `anthropic`, or `bedrock-claude`) has no credentials configured in this
  deployment, even though the model itself is in the catalog. An operator
  needs to configure that provider's credentials before any model under it
  can be used; see [Getting started](../getting-started.md).

For a coding agent, this check is against the catalog only — coding runs use
the coding proxy's own credentials, not the agent owner's, so
`provider_not_configured` for a coding agent means the proxy itself is not
configured for that provider.

See [Models and pricing](../models.md) for how the catalog works and who can
change it.
