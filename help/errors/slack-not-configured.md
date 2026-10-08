---
id: errors/slack-not-configured
title: Notification bot token not configured
summary: link_notification_channel, unlink_notification_channel, and test_notification_channel are refused because wardby has no Slack bot token configured.
audience: operator
tags: [error, notifications, configuration, config, setup, WARDBY_SLACK_BOT_TOKEN]
appliesTo: ">=0.6.0"
---

# Notification bot token not configured

`link_notification_channel`, `unlink_notification_channel`, and
`test_notification_channel` are refused when the wardby server has no
`WARDBY_SLACK_BOT_TOKEN` set. Without it, Slack workflow notifications are
entirely disabled: the notification dispatcher does not start, and any event
that would otherwise post to Slack is skipped — none are queued or
backfilled once you do configure it.

`list_notification_channels` still works and shows any links created
earlier, but nothing is delivered to them while Slack is unconfigured.

## What to do

1. Create the Slack app from
   [`deploy/slack/app-manifest.yaml`](../../deploy/slack/app-manifest.yaml)
   and install it to your workspace.
2. Copy the Bot User OAuth Token (`xoxb-…`) and set
   `WARDBY_SLACK_BOT_TOKEN`, stored like any other provider credential.
3. Restart wardby. The startup log line `chat notifications acting as`
   confirms which Slack workspace and bot it authenticated as.

See [Send workflow updates to Slack](../../docs/slack-notifications.md) for
the full setup.
