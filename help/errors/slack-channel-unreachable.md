---
id: errors/slack-channel-unreachable
title: Slack channel unreachable
summary: wardby's bot can no longer post to a linked Slack channel — it was removed, archived, or never invited — and that channel's pending deliveries have failed.
audience: operator
tags: [error, slack, notifications, channel, not_in_channel, channel_not_found, is_archived]
appliesTo: ">=0.6.0"
---

# Slack channel unreachable

Slack returned `channel_not_found`, `not_in_channel`, or `is_archived` when
wardby tried to post or update a message. This means the bot genuinely
cannot write to that channel right now — the channel was deleted or
archived, or (most commonly) the bot was never invited to a private
channel.

wardby fails that channel's pending deliveries immediately rather than
retrying forever, and stamps the error on every `NotificationChannel` link
pointing at it. `list_notification_channels` shows it in `lastError` until
you fix it.

## What to do

1. In Slack, confirm the channel still exists and isn't archived.
2. If it's private, invite the bot: `/invite @wardby` (or whatever you named
   the app) in that channel.
3. Confirm it worked with `test_notification_channel` — it posts "✅ wardby
   is connected to this channel."
4. Re-link the channel with `link_notification_channel` using the same
   arguments as before. Re-linking clears `lastError` and resumes delivery
   for anything still pending.

If the channel is gone for good, remove the link with
`unlink_notification_channel` instead.

See [Send workflow updates to Slack](../../docs/slack-notifications.md) for
the full guide.
