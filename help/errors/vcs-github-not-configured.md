---
id: errors/vcs-github-not-configured
title: GitHub is not configured for coding agents
summary: A coding run used a GitHub repository, but the wardby server has no GitHub App credentials (GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY).
audience: operator
tags: [error, coding-agents, github, vcs, configuration, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY]
appliesTo: ">=0.5.0"
---

# GitHub is not configured for coding agents

`vcs_github_not_configured` means a coding run's repository is a GitHub
repository, but the wardby server was started without GitHub App credentials,
so it cannot clone the repository or push the result. The run's failure
category is `preflight`. Nothing is pushed.

The server starts without the credentials so that it can serve local git
repositories (`local:/absolute/path`) on its own. When neither GitHub App
credentials nor `LOCAL_REPO_ROOTS` are set, the server logs a warning at
startup that names both options.

## What to do

Choose one:

1. **Use GitHub.** Install a GitHub App on the repository, then set
   `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` on the wardby server and restart
   it. See [Connect GitHub repositories](../github.md).
2. **Use a local repository.** If the code is in a git folder on the machine
   that runs the wardby server, set `LOCAL_REPO_ROOTS` and point the agent's
   `codingProfile.repository` at `local:/absolute/path`. See
   [Local git repositories](../local-repositories.md).

Related: [Get started](../getting-started.md).
