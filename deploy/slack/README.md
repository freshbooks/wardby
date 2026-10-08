# deploy/slack/

Slack app manifest for wardby's outbound-only workflow notifications: a
linked channel sees a Jira card or pull request move from pickup to merge,
one thread per card. Nothing in Slack can start or affect a run — wardby
requests no event subscriptions and no interactivity.

## Create the app

1. Open [api.slack.com/apps](https://api.slack.com/apps) and choose
   **Create New App → From a manifest**.
2. Pick the workspace the app should belong to.
3. Paste the contents of [`app-manifest.yaml`](app-manifest.yaml) (YAML) and
   create the app.
4. On the app's **OAuth & Permissions** page, click **Install to Workspace**
   and approve the requested scopes.
5. Copy the **Bot User OAuth Token** (starts `xoxb-`). This is the only
   credential wardby needs; it never sees your Slack workspace's other
   tokens or your own user token.

## Configure wardby

Set `WARDBY_SLACK_BOT_TOKEN` to the bot token above and restart wardby. Store
it in your secrets backend the same way you store other provider credentials
(`GITHUB_APP_PRIVATE_KEY`, `WARDBY_JIRA_API_TOKEN`), never in a committed
file. See [Send workflow updates to Slack](../../docs/slack-notifications.md)
for the full setup, the channel-linking tools, and failure modes.

## Optional: per-agent display names

The manifest comments out `chat:write.customize`, which lets wardby post a
message about an agent's work (picked up, failed, review posted) under that
agent's name instead of `wardby`; other messages still post as `wardby`, and
no icon is set. To use it, uncomment that scope in the manifest, re-create
(or update) the app from the edited manifest, reinstall it to the workspace,
and set `WARDBY_SLACK_CUSTOMIZE=true`.

## One app per workspace

Every operator creates and installs their own copy of this app in their own
Slack workspace. wardby is not a distributed Slack app in this phase — there
is no shared app listing to install from, and no OAuth flow to connect an
existing one.
