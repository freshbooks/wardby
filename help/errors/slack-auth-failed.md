---
id: errors/slack-auth-failed
title: Bot authentication failed — invalid or revoked token
summary: wardby's Slack bot token is invalid, revoked, disabled, or missing a required scope, so delivery to every linked channel is paused.
audience: operator
tags: [error, notifications, auth, authentication, invalid_auth, token_revoked, missing_scope]
appliesTo: ">=0.6.0"
---

# Slack authentication failed

Slack returned `invalid_auth`, `token_revoked`, `account_inactive`,
`missing_scope`, or `not_authed` for `WARDBY_SLACK_BOT_TOKEN`. This is
different from a single channel being unreachable: it means the token
itself no longer works, so wardby pauses delivery to **every** linked
channel rather than attempting and failing each one. Deliveries already
queued stay pending — nothing is lost — and wardby automatically re-checks
the token every five minutes with Slack's `auth.test`, resuming delivery as
soon as it succeeds.

wardby logs this once per pause, not on every retry.

## What to do

1. In Slack, check the app's **OAuth & Permissions** page: is the bot
   installed, and does it still have `chat:write` at minimum?
2. If the app's scopes changed (for example after editing
   [`app-manifest.yaml`](../../deploy/slack/app-manifest.yaml)), reinstall
   the app to the workspace to apply them.
3. If the token was revoked or the app was uninstalled, reinstall it and
   copy a fresh Bot User OAuth Token.
4. Set the new token as `WARDBY_SLACK_BOT_TOKEN` and restart wardby. The
   startup log line `chat notifications acting as` confirms the fix.

See [Send workflow updates to Slack](../../docs/slack-notifications.md) for
the full guide.
