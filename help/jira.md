---
id: jira
title: Run Jira agents
summary: Connect Wardby to Jira Cloud with a service account, add the webhook, and link agents to projects.
audience: operator
tags: [jira, issue-tracker, webhooks, service-account]
appliesTo: >=0.2.1
---

# Run Jira agents

A native agent linked to a Jira Cloud project can be started by issue events
and can read, search and comment on issues in that project. Everything it does
is attributed to one Atlassian service account whose API token Wardby holds.
Use only a service-account token (the email-plus-token setup is refused at
startup); a personal token would attribute agent actions to that person. Check
the `Jira acting as` startup line to confirm the account.

## Setup checklist

1. In Atlassian Administration, create a service account (Directory, then
   Service accounts). Give it a project role with Browse Projects, Add
   Comments and Edit Own Comments in each project agents will use, and only
   there. To let agents change issues also add Transition issues, Edit issues
   and Link issues. Its permissions are the outer boundary of what any linked
   agent can read or change.
2. Create an API token for it with scopes covering reading issues, JQL search
   and writing comments, plus reading its own identity (`read:jira-work`,
   `write:jira-work` and `read:jira-user`), and an expiry.
3. Find your site's cloudId at `https://your-site.atlassian.net/_edge/tenant_info`.
4. In Jira, Settings, System, WebHooks: add
   `https://<your-wardby-host>/hosts/jira/events` with a secret of 20 or more
   characters and the events Issue created, Issue updated, Comment created and
   Comment updated.
   Editing a comment that mentions the service account can trigger the agent
   again when the editor is a trusted account; leave out Comment updated if you
   don't want that.
5. Set `WARDBY_JIRA_SITE_URL`, `WARDBY_JIRA_API_BASE_URL`
   (`https://api.atlassian.com/ex/jira/<cloudId>`), `WARDBY_JIRA_API_TOKEN` and
   `WARDBY_JIRA_WEBHOOK_SECRET`, then restart. The startup log line
   `Jira acting as` shows which account Wardby uses; confirm it is the service
   account. Optionally set `WARDBY_JIRA_API_TOKEN_EXPIRES_AT` to get a warning
   14 days before expiry.
6. A Wardby administrator links the agent with `link_issue_project`, for
   example `projectKey: "PROJ"`, `access: "write"`,
   `triggers: ["transitioned", "mention"]`,
   `triggerStatuses: ["Ready for agent"]` and
   `trustedAccountIds: ["<accountId>"]`. To let the agent change issues, add
   `allowedTransitions` (target status names) and `writableFields` (`labels`,
   `components`, `priority`, `customfield_N`); both need `write` access and an
   empty list means the tool refuses.

## What agents can do

Beyond reading, searching and commenting, linked agents get
`jira_list_transitions`, `jira_transition`, `jira_update_fields`,
`jira_link_issues`, and `jira_get_property` / `jira_set_property` for private
per-issue state. Each authorizes against the issue's own project and the
agent's live link. Run status comments include an `Agent spend: $...` line.
If the token belongs to a person, Wardby refuses to act: startup logs an error
and the webhook answers 503 `jira_personal_account`. Deliveries with a
timestamp older than two hours (or more than five minutes ahead) are ignored.
Two recipes, triage on create and scheduled JQL sweeps, are in the full guide.

## Trust rules

Only people (not customers, apps, or the service account itself) can trigger
agents. Mention and assignment triggers work only for the account ids in the
link's `trustedAccountIds`. Issue text is untrusted input to the agent, and
agents cannot @-mention people. Wardby confines each agent to its linked
projects, but JQL functions can still reveal facts about other projects the
service account can browse. The tool names `jira_get_issue`, `jira_search`,
`jira_comment`, `jira_edit_own_comment`, `jira_list_transitions`,
`jira_transition`, `jira_update_fields`, `jira_link_issues`,
`jira_get_property` and `jira_set_property` are reserved; rename any existing
user-defined tool with one of them before linking the agent.

For the full guide, including tools, link options, token rotation and
troubleshooting, follow [`docs/jira-agents.md`](../docs/jira-agents.md).
