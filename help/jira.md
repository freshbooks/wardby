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
is attributed to one Atlassian service account whose API token Wardby holds;
personal tokens are refused at startup.

## Setup checklist

1. In Atlassian Administration, create a service account (Directory, then
   Service accounts). Give it a project role with Browse Projects, Add
   Comments and Edit Own Comments in each project agents will use.
2. Create an API token for it with scopes covering reading issues, JQL search
   and writing comments (`read:jira-work` and `write:jira-work`), and an
   expiry.
3. Find your site's cloudId at `https://your-site.atlassian.net/_edge/tenant_info`.
4. In Jira, Settings, System, WebHooks: add
   `https://<your-wardby-host>/hosts/jira/events` with a secret of 20 or more
   characters and the events Issue created, Issue updated, Comment created and
   Comment updated.
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
   `trustedAccountIds: ["<accountId>"]`.

## Trust rules

Only people (not customers, apps, or the service account itself) can trigger
agents. Mention and assignment triggers work only for the account ids in the
link's `trustedAccountIds`. Issue text is untrusted input to the agent, and
agents cannot @-mention people.

For the full guide, including tools, link options, token rotation and
troubleshooting, follow [`docs/jira-agents.md`](../docs/jira-agents.md).
