# Jira agents

A native wardby agent can be linked to one or more Jira Cloud projects. It is
then started by issue events (a status change, a label, an assignment, an
@-mention), reads and searches issues, and replies with comments. This guide
sets up the Jira side, configures wardby, and links an agent.

Jira Cloud only. One Jira site per wardby deployment.

## What it does

- **Triggers.** A link lists which events start the agent: `created`,
  `transitioned` (to one of the statuses you name), `labeled` (with one of the
  labels you name), `assigned` (to the service account) and `mention` (the
  service account is @-mentioned in a comment). Event triggers need write
  access.
- **Tools.** Linked agents get four tools, limited to their linked projects:
  `jira_get_issue` (summary, description, status, recent comments),
  `jira_search` (JQL, scoped to the linked projects), `jira_comment`, and
  `jira_edit_own_comment` (only comments that agent posted earlier). On a
  read-only link the two comment tools are refused.
- **Status comments.** When an event starts a run, wardby posts a short
  "working on it" comment on the issue and edits it with the outcome when the
  run ends. Every agent comment ends with a footer naming the agent.

Phase-1 agents read and comment. They do not change status, fields, or assignees.

## Why a service account

Everything an agent does in Jira is attributed to the account whose API token
wardby holds. wardby supports only Atlassian
[service account](https://support.atlassian.com/user-management/docs/understand-service-accounts/)
tokens used through the API gateway. The email-plus-token (Basic) setup is
refused at startup (`WARDBY_JIRA_API_EMAIL`). Do not put a personal token in
`WARDBY_JIRA_API_TOKEN`: everything the agent does would be attributed to that
person. Check the `Jira acting as` startup line to confirm the account. Service accounts do not use a
Jira user seat; see Atlassian's page for how many your plan includes.

## 1. Create the service account

In Atlassian Administration go to **Directory > Service accounts** and select
**Create a service account**. Give it a recognisable name (for example
`wardby`). See
[Understand service accounts](https://support.atlassian.com/user-management/docs/understand-service-accounts/).

Then grant it access to Jira and give it a project role in every project
agents will work in, with these project permissions: **Browse Projects**,
**Add Comments**, **Edit Own Comments**. Grant nothing more: wardby never needs
to administer projects. Grant these only in the projects agents should work in,
never organization-wide: the service account's Jira permissions are the outer
boundary of what any linked agent can read or change.

## 2. Create its API token

In Atlassian Administration open the service account, select **Create
credentials**, choose **API token**, name it, and set an expiry (Atlassian
allows 1 to 365 days). Choose these classic scopes when prompted:

- `read:jira-work`: read issues and comments, and search with JQL.
- `write:jira-work`: add and edit comments.
- `read:jira-user`: read the service account's own identity
  (`/rest/api/3/myself`). wardby needs it to recognize its own events and
  mentions; without it every webhook delivery fails.

Granular scopes are an alternative if you want a narrower token, but then you
must grant the granular equivalent of each call above. Copy the token when it
is shown.

See [Manage API tokens for service accounts](https://support.atlassian.com/user-management/docs/manage-api-tokens-for-service-accounts/)
and the [Jira scope reference](https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/).

Service-account tokens work only through the Atlassian API gateway,
`https://api.atlassian.com/ex/jira/<cloudId>`, where `<cloudId>` identifies your
site. Find it by opening `https://your-site.atlassian.net/_edge/tenant_info`
(the response is `{"cloudId":"..."}`), or from the ID after `/s/` in the
`admin.atlassian.com` address when you select the site. See
[How to find your Atlassian Cloud site's Cloud ID](https://support.atlassian.com/jira/kb/retrieve-my-atlassian-sites-cloud-id/).

## 3. Create the webhook

In Jira, open **Settings > System > WebHooks** and create a webhook:

- **URL:** `https://<your-wardby-host>/hosts/jira/events`
- **Secret:** a random string of at least 20 characters. Use the same value for
  `WARDBY_JIRA_WEBHOOK_SECRET`.
- **Events:** Issue created, Issue updated, Comment created, Comment updated.
  With Comment updated, editing a comment that mentions the service account
  can trigger the agent again (only when the editor is a trusted account);
  leave it out if you don't want edits to re-trigger.
- **JQL filter (optional):** limit delivery to the linked projects, for example
  `project in (PROJ)`.

wardby verifies the `X-Hub-Signature` HMAC (`sha256`) on every delivery and
de-duplicates retries by `X-Atlassian-Webhook-Identifier`. Atlassian notes that
a webhook imported with a secret is not delivered until the secret is rotated;
if deliveries never arrive, edit the webhook and set the secret again. See
[Jira webhooks](https://developer.atlassian.com/cloud/jira/platform/webhooks/).

The endpoint must be reachable from Atlassian's servers over HTTPS.

## 4. Configure wardby

Set these variables (see `.env.example`) and restart:

| Variable                           | Value                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `WARDBY_JIRA_SITE_URL`             | Bare https origin people browse, `https://your-site.atlassian.net`. Issue links in comments use it. |
| `WARDBY_JIRA_API_BASE_URL`         | `https://api.atlassian.com/ex/jira/<cloudId>` (required).                                           |
| `WARDBY_JIRA_API_TOKEN`            | The service account's API token.                                                                    |
| `WARDBY_JIRA_WEBHOOK_SECRET`       | The webhook secret, 20 or more characters.                                                          |
| `WARDBY_JIRA_API_TOKEN_EXPIRES_AT` | Optional. Token expiry (`YYYY-MM-DD`); wardby logs a warning 14 days before.                        |

Set the four required variables together or none of them. On startup wardby
logs `Jira acting as` with the account id, display name and account type it
authenticated as. Check that this is the service account you created.

## 5. Link an agent

A wardby administrator (an `agents:admin` principal with the admin role) links
a native agent to a project with the `link_issue_project` MCP tool. Linking is
admin-approved because wardby cannot verify an agent owner's own Jira access.
Example arguments:

```json
{
  "agentId": "<agent id>",
  "projectKey": "PROJ",
  "access": "write",
  "triggers": ["transitioned", "mention"],
  "triggerStatuses": ["Ready for agent"],
  "trustedAccountIds": ["<accountId>"]
}
```

| Argument                | Meaning                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `access`                | `read` or `write`. Comments and event triggers need `write`.                                                                                             |
| `triggers`              | Any of `created`, `transitioned`, `labeled`, `assigned`, `mention`.                                                                                      |
| `triggerStatuses`       | Required for `transitioned`: the target statuses (case-insensitive).                                                                                     |
| `triggerLabels`         | Required for `labeled`: labels whose addition triggers the agent.                                                                                        |
| `trustedAccountIds`     | Required for `mention` and `assigned`: Jira account ids whose mentions and assignments may trigger the agent. Find an id in a person's Jira profile URL. |
| `jqlFilter`             | Optional. Only issues matching this JQL trigger the agent. If wardby cannot evaluate it, the event is skipped.                                           |
| `commentVisibilityRole` | Optional. Restrict the agent's comments to a project role.                                                                                               |

The tool names `jira_get_issue`, `jira_search`, `jira_comment` and
`jira_edit_own_comment` are reserved: a user-defined tool with one of these
names on an agent conflicts once that agent is linked to a Jira project, so
rename it first.

Re-linking a project replaces the whole link: send the full desired state.
`unlink_issue_project` removes a link and `list_issue_projects` shows them.

To use the `mention` trigger, people @-mention the service account in a
comment. To use `assigned`, they assign the issue to it.

## Security model

- Only Jira users of type "atlassian" can trigger agents. Customers of Jira
  Service Management, apps, and the service account's own changes never do, so
  an agent cannot re-trigger itself.
- `mention` and `assigned` triggers work only for accounts in the link's
  `trustedAccountIds`. `transitioned`, `labeled` and `created` rely on Jira's
  own permissions for who can perform those actions.
- Issue summaries, descriptions and comments are untrusted input. wardby hands
  them to the agent as separate, labelled context, never as its instructions;
  still, write agent prompts on the assumption that issue text can be hostile,
  and do not tell an agent to echo secrets or internal details, because its
  comments are visible to everyone who can see the issue (or the role you set
  in `commentVisibilityRole`).
- Agents cannot @-mention or notify people: `@` in a comment body is plain text.
- The token and webhook secret stay in the wardby server; agents and sandboxes
  never see them.
- wardby confines each agent to its linked projects, but JQL functions can
  still reveal facts about other projects the service account can browse, so
  keep its permissions to the projects you intend.
- Agents can only touch projects they are linked to, and can only edit comments
  they posted.

## Rotating the token

Create a new token for the service account, set `WARDBY_JIRA_API_TOKEN` (and
`WARDBY_JIRA_API_TOKEN_EXPIRES_AT`), restart wardby, then delete the old token
in Atlassian Administration. Links are unaffected. To rotate the webhook
secret, change it on the webhook and in `WARDBY_JIRA_WEBHOOK_SECRET`, and restart.

## Troubleshooting

- **Startup error about `WARDBY_JIRA_API_BASE_URL`:** it must be exactly
  `https://api.atlassian.com/ex/jira/<cloudId>`.
- **No runs on events:** check the webhook's delivery status in Jira, that the
  secret matches, the project is linked with `write` access, and the actor is
  a person (and in `trustedAccountIds` for mentions and assignments).
- **401 or 403 from Jira in tool results:** the token expired, lacks scopes, or
  the service account has no role in that project.
