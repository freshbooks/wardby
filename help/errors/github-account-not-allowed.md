---
id: errors/github-account-not-allowed
title: The repository's GitHub account is not served by this server
summary: The repository belongs to a GitHub user or organization that is neither the GitHub App's owner nor listed in WARDBY_GITHUB_ALLOWED_ACCOUNTS, so wardby refuses to link or use it.
audience: operator
tags: [error, github, repositories, configuration, WARDBY_GITHUB_ALLOWED_ACCOUNTS, link_repository]
appliesTo: ">=0.6.0"
---

# The repository's GitHub account is not served by this server

`github_account_not_allowed` means the repository's owner is not one of the
accounts this server serves through its GitHub App: the App's owner and the
accounts in `WARDBY_GITHUB_ALLOWED_ACCOUNTS`. `link_repository` and coding
profiles refuse such a repository, even with `adminOverride`, and runs on an
existing link to it are refused.

## What to do

- **The repository should be served:** an operator adds its owner's login to
  `WARDBY_GITHUB_ALLOWED_ACCOUNTS` and restarts the server, then links it again.
- **It should not:** use a repository owned by a served account, or another
  wardby server with its own GitHub App.

Related: [Connect GitHub repositories](../github.md).
