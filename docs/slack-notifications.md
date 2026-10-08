# Send workflow updates to Slack

Link a Slack channel to a Jira project or to a native agent, and wardby posts
that project's or agent's workflow updates there: a card picked up, a pull
request opened, a review verdict, fix rounds, and the merge — one thread per
card. This is outbound only: nothing in Slack starts or affects a run, and
wardby exposes no new inbound endpoint for it.

## What it does

### Events

Six kinds of lifecycle event can post to a linked channel:

| Kind              | Posts when                                                                    | Content                                                                      |
| ----------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `issue_picked_up` | A Jira event starts a run on a linked issue                                   | Issue key, title, and link; agent name; trigger kind                         |
| `run_failed`      | A top-level run ends `failed`, `budget_exhausted`, `cancelled`, or `lost`     | Agent name, status, a short first-line reason (never the full error)         |
| `pr_opened`       | A coding run opens a pull request                                             | Repository#number and link, the issue it is for, any Jira status move        |
| `review_posted`   | wardby's own review check posts a verdict                                     | `APPROVE` / `CHANGES_REQUESTED` / `COMMENT`, the reviewer agent, the PR link |
| `review_fix`      | An automatic [fix round](../help/review-fix-rounds.md) starts or hits the cap | Round number of the cap, started or capped                                   |
| `pr_closed`       | A pull request is merged or closed                                            | Merged or closed, any Jira status move                                       |

A run finishing successfully is not its own event — on the workflow it shows
up as `pr_opened` or `review_posted` already. Child coding runs started by a
parent surface through the parent's own `run_failed`, not their own.

### Threads

Each channel gets one thread per card: one per Jira issue (when the event has
one) or one per pull request (when it doesn't). The first event for a card
posts a parent message naming the issue or pull request; every later event
for the same card is a reply in that thread, and the parent is kept updated
with a short status line:

```
picked up → PR open → changes requested → fixing (round 1/2) → approved → merged ✅ / closed / failed ❌
```

Most events only post as a thread reply. A merge and a top-level run failure
also post to the channel itself, so they are visible without opening the
thread.

### What is never sent

wardby never posts code, diffs, review bodies, or run output to Slack. Error
messages shown in Slack are a short first line only (at most 200 characters),
never a full error or stack trace.

## 1. Create the Slack app

Use the manifest in [`deploy/slack/app-manifest.yaml`](../deploy/slack/app-manifest.yaml):

1. Open [api.slack.com/apps](https://api.slack.com/apps), choose **Create New
   App → From a manifest**, pick your workspace, and paste the manifest.
2. On **OAuth & Permissions**, click **Install to Workspace** and approve the
   requested scopes.
3. Copy the **Bot User OAuth Token** (starts `xoxb-`).

See [`deploy/slack/README.md`](../deploy/slack/README.md) for the full
walkthrough, including the optional per-agent display-name scope.

## 2. Configure wardby

| Variable                    | Value                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `WARDBY_SLACK_BOT_TOKEN`    | The bot token from step 1 (`xoxb-…`). Unset = Slack notifications are disabled.                   |
| `WARDBY_SLACK_API_BASE_URL` | Optional. Overrides the Slack Web API base URL (`https://slack.com/api`); must be `https`.        |
| `WARDBY_SLACK_CUSTOMIZE`    | Optional, `true` or `false` (default `false`). Needs `chat:write.customize` in the installed app. |

Store `WARDBY_SLACK_BOT_TOKEN` in your secrets backend the same way you store
other provider credentials (`GITHUB_APP_PRIVATE_KEY`, `WARDBY_JIRA_API_TOKEN`)
— never in a committed file. Restart wardby after setting it. The startup log
line `chat notifications acting as` names the Slack team and bot user id
wardby authenticated as; if authentication fails instead, wardby logs an
error and starts with delivery paused rather than failing to boot (see
[Failure modes](#failure-modes)).

Without `WARDBY_SLACK_BOT_TOKEN`, `link_notification_channel`,
`unlink_notification_channel`, and `test_notification_channel` are refused
and the dispatcher does not start; see
[`errors/slack-not-configured`](../help/errors/slack-not-configured.md).

## Scopes and why

| Scope                  | Required    | Used for                                                                                                  |
| ---------------------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| `chat:write`           | Yes         | Posting and updating the bot's own messages, including threaded replies                                   |
| `chat:write.public`    | Recommended | Posting to public channels without inviting the bot first                                                 |
| `channels:read`        | Recommended | Validating a channel id and recording its name when linking                                               |
| `groups:read`          | Recommended | The same, for private channels                                                                            |
| `chat:write.customize` | Optional    | Posting under a linked agent's own name/icon instead of the app's default (`WARDBY_SLACK_CUSTOMIZE=true`) |

Without `channels:read`/`groups:read`, linking still accepts a raw channel id
but skips validating it. Private channels always need `/invite @wardby` (or
whatever you named the app) regardless of scopes — Slack never lets a bot see
or post to a private channel it hasn't been invited to. `chat.postMessage` is
rate-limited to about one message per second per channel; wardby's dispatcher
paces its own posts to stay under that.

## Link channels

Use the `link_notification_channel` MCP tool. It needs `agents:admin` with
the admin role, the same trust model as `link_issue_project`: wardby cannot
verify a caller's own Slack workspace access, so an administrator approves
every link.

Link a channel to a Jira project:

```json
{
  "channel": "C0123456789",
  "projectKey": "PAY",
  "issueProvider": "jira",
  "events": ["issue_picked_up", "pr_opened", "review_posted", "pr_closed"],
  "includeCost": true
}
```

Link a channel to an agent instead (every event for that agent's runs, no
filter):

```json
{
  "channel": "C0123456789",
  "agentId": "<agent id>"
}
```

- Give exactly one of `projectKey` (with optional `issueProvider`, default
  `jira`) or `agentId`.
- `channel` is the Slack channel id — `C…` for a public channel, `G…` for a
  private one — never a `#name`. Find it in the channel's details in Slack
  (**View channel details**, near the bottom). Passing a `#name` is refused.
- `events` narrows which of the six kinds post to this link; omit it (or pass
  an empty list) for all six.
- `includeCost` appends the run's spend line to messages for this link.
- Invite the bot to any private channel before linking it:
  `/invite @wardby` in that channel.
- Re-linking the same channel and subject replaces `events` and
  `includeCost` and clears any previously recorded delivery error — send the
  full desired state each time.

Then confirm delivery works before relying on it:

```json
{ "id": "<link id from link_notification_channel>" }
```

`test_notification_channel` posts "✅ wardby is connected to this channel." —
if the bot can't write there, you get the error immediately instead of
finding out when the first real event is dropped.

`list_notification_channels` shows every link's `lastError` and its pending
and failed delivery counts; filter by `projectKey`, `agentId`, or `channel`.
Listing your own agent's links needs read access to that agent; listing
everything (or filtering by `projectKey`) needs `agents:admin` with the admin
role. `unlink_notification_channel` removes a link by `id`.

## Failure modes

- **Channel not found, bot not in channel, or channel archived.** That
  channel's pending deliveries fail immediately, and every link to it shows
  the error in `lastError` until you fix it. Invite the bot
  (`/invite @wardby`) or otherwise fix the channel in Slack, then re-link it
  — re-linking clears `lastError` and resumes delivery. See
  [`errors/slack-channel-unreachable`](../help/errors/slack-channel-unreachable.md).
- **Invalid or revoked token, or a missing scope.** Delivery pauses for every
  linked channel (no deliveries are lost — they stay pending), and wardby
  re-checks every five minutes; it resumes automatically once the check
  succeeds. See [`errors/slack-auth-failed`](../help/errors/slack-auth-failed.md).
- **Rate limits.** wardby paces its own posts to about one per second per
  channel; if Slack still responds with a rate-limit error, that delivery is
  retried after the delay Slack specifies, with no attempt counted against
  the retry limit below.
- **Transient errors** (network issues, Slack 5xx responses) are retried with
  increasing back-off, up to 10 attempts, before the delivery is marked
  failed.
- **Events while Slack isn't configured.** An event recorded before
  `WARDBY_SLACK_BOT_TOKEN` is set is not queued and is not delivered once you
  configure it — only events recorded after Slack notifications are enabled
  reach Slack.
- **Retention.** Delivery records are kept for 30 days and then pruned.

## Security

Phase 1 is outbound only: wardby requests no event subscriptions and no
interactivity in the manifest, so there is no new inbound endpoint and
nothing posted in Slack can start or affect a run.

What leaves to Slack: issue keys, titles, and their links; pull request
numbers and links; agent names; review verdicts; fix-round numbers; and, only
when a link's `includeCost` is on, the run's spend line. wardby never posts
code, diffs, review bodies, or run output, and an error message shown in
Slack is a short first line only, never a full error or stack trace.

The bot token stays on the wardby server; agents, sandboxed tools, and
coding-run workers never see it.
