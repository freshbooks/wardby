# Contributing to Wardby

Wardby welcomes focused bug fixes, tests, documentation improvements, and
portable deployment enhancements.

## Development setup

1. Install the Node.js version in `.nvmrc` and Docker.
2. Run `npm ci`.
3. Copy `.env.example` to `.env` and use test-only credentials.
4. Start PostgreSQL with `npm run db:up` and apply migrations with
   `npm run prisma:migrate`.
5. `npm ci` already generated the Prisma client (the `prepare` script) into
   `src/generated/prisma`, which is git-ignored. Regenerate it with
   `npm run prisma:generate` after any `prisma/schema.prisma` change, before
   `npm run typecheck` or `npm test`: both fail if the client is missing or
   stale.

### Running the full stack with Tilt

`tilt up` starts PostgreSQL, applies migrations and runs `wardby serve` with
self-hosted auth, so no identity provider is needed. It generates any missing
`SECRET_APP_KEY` and auth keys into `.env.local` and creates a `dev-admin` login
(change the name with `WARDBY_DEV_SUBJECT`). The login key is written to
`.tilt/dev-login-key`; both files are git-ignored and owner-only. The only value
you supply is a model provider key (`OPENAI_API_KEY`, or `LLM_PROVIDER=anthropic`
with `ANTHROPIC_API_KEY`) in `.env` or `.env.local`.

Tilt also launches the desktop viewer (`apps/viewer`, a Tauri app) in its own
window. It needs Rust ([rustup](https://rustup.rs)) and the Xcode Command Line
Tools; the first start compiles the Rust shell and takes a few minutes. Set
`WARDBY_VIEWER=0` to skip it. The viewer opens with the local server already
added (`http://127.0.0.1:8080`); you only need to sign in with the key in
`.tilt/dev-login-key`.

Tilt also starts Prometheus and Grafana (`http://127.0.0.1:3000`,
`admin` / `wardby-local-only`); set `WARDBY_OBSERVABILITY=0` to skip them. Only
the coding proxy emits metrics, so the dashboards cover coding runs. The coding
proxy needs `OPENAI_API_KEY` (from the shell, `.env.local` or `.env`); a missing
`ANTHROPIC_API_KEY` is replaced by a placeholder, so Claude coding runs would fail.
Without `OPENAI_API_KEY`, Tilt warns and skips the stack (`WARDBY_OBSERVABILITY=1`
makes that an error instead).

Tilt can also run Claude Code and Codex coding agents on the Docker job
launcher, against a local git repository or a GitHub repository. For a local
repository, set `LOCAL_REPO_ROOTS` (`:`-separated trusted folders; each
repository must be a git top level, git 2.24 or later). For GitHub
repositories, set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (see
[Coding agent setup](docs/coding-agent-setup.md)). Set either in the shell,
`.env.local` or `.env`. Tilt then builds the worker and tool-runner
images (`coding-images`), starts the coding proxy (`coding-proxy`), runs
`wardby coding preflight` (`coding-preflight`) and starts `wardby serve` with
`JOB_LAUNCHER=docker`, resolving each image to its local `sha256:` ID. No GitHub
App or webhook is needed for `local:/absolute/path` repositories; see
[Coding agent setup](docs/coding-agent-setup.md). The proxy needs
`ANTHROPIC_API_KEY` for Claude Code and `OPENAI_API_KEY` for Codex; a missing key
gets a placeholder, so runs on that provider fail. Without `LOCAL_REPO_ROOTS` or
the GitHub App values, none of this starts. Two limits: the proxy image is not rebuilt on source
changes (re-run `coding-proxy` from the Tilt UI), and `wardby serve` restarts on
every `src/` change, so a run in flight during a restart can be reported lost.
Wait for runs to finish before editing.

To share one GitHub App and one Anthropic key across a team, store them in
Google Secret Manager. The project defaults to the one set in
`scripts/dev-bootstrap.mjs`; set `WARDBY_GSM_PROJECT` (shell, `.env.local` or
`.env`) to use another, or `WARDBY_GSM_PULL=0` to skip the pull. When Tilt
loads, it reads `<prefix>github-app-id`,
`<prefix>github-app-private-key`, `<prefix>github-app-client-id`,
`<prefix>github-app-client-secret` and `<prefix>anthropic-api-key` with
`gcloud secrets versions access` (you must be signed in with `gcloud` and have
access) and writes them to `.env.local`, replacing any existing values for those
variables. The prefix is `wardby-dev-` unless `WARDBY_GSM_SECRET_PREFIX` says
otherwise. Values stay in memory and are never logged. Restart Tilt to pick up a
rotated secret. Without `gcloud` access to the default project, Tilt warns and
leaves `.env.local` as it is; an explicit `WARDBY_GSM_PROJECT` fails instead.

The `wardby` resource has a **Run a task** button in the Tilt UI. Fill in the
task, model, budget cap (at most 5 USD) and a name prefix; it creates a fresh
native agent and runs it once, streaming the output to the resource's log. It
makes a real, billed model request, and the run appears in the viewer. The
button comes from Tilt's `uibutton` extension, which Tilt fetches on first load.

The server listens on `http://127.0.0.1:8080` (`WARDBY_MCP_PORT` to change it);
the MCP endpoint is `/mcp`. Use `127.0.0.1`, not `localhost`: the server rejects
any other Host.

#### Connect Claude Code and run a coding agent on a GitHub repository

1. **Sign-in key.** Tilt's `dev-user` step creates an admin user (`dev-admin`,
   or `WARDBY_DEV_SUBJECT`) and writes its login key to `.tilt/dev-login-key`
   (owner-only, git-ignored). If the key is rejected, for example after a
   database reset, create a new admin and use the key it prints:
   `npm run cli -- auth user create --subject <name> --role admin` (with
   `DATABASE_URL` pointing at the local database).
2. **Connect.** Run
   `claude mcp add --transport http wardby-local http://127.0.0.1:8080/mcp`,
   then open `/mcp` in Claude Code, pick `wardby-local`, authenticate and paste
   the key on the sign-in page. After the server restarts, choose **Reconnect**
   in `/mcp`; you don't need to add it again.
3. **GitHub App.** Register an App with **Contents** and **Pull requests**
   read and write, the webhook inactive, and the callback URL
   `http://127.0.0.1:8080/hosts/github/user-callback`; then **install it on
   each repository** the agent will change (App settings, Install App). Set
   `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (the whole PEM, quoted, as one
   value) in `.env.local`, plus `GITHUB_APP_CLIENT_ID` and
   `GITHUB_APP_CLIENT_SECRET` for account linking. With these set, Tilt turns on
   the coding setup, as it does for `LOCAL_REPO_ROOTS`. Agents started by
   webhooks (mentions, review agents, merge watchers) can't work locally,
   because GitHub can't reach `127.0.0.1`; trigger agents by hand.
4. **Link your GitHub account.** Call `link_host_account` with no arguments,
   open the returned `authorizeUrl` signed in to GitHub, authorize, then call it
   again with `confirmationCode` set to the code on the callback page. Your
   account needs write access to the repository.
5. **Run an agent.** Ask Claude Code to use `wardby-local` to create a coding
   agent on `owner/repo` with a small budget, trigger it, and check the run with
   `get_run`. The result is a draft pull request and a cost.

If `create_agent` says it "could not verify your GitHub access", the App isn't
installed on that repository. Tilt may refuse to start while `kubectl` points
at a cluster; the Tiltfile allows the current context because it deploys
nothing to Kubernetes.

Before opening a pull request, run:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

`format:check` runs Prettier over Markdown as well as code; fix failures with
`npx prettier --write <paths>`.

Changes to coding workers, authentication, budgets, isolation, migrations, or
release boundaries should include focused negative tests. Do not commit secrets,
private keys, production data, prompts, repository contents, or generated
worker artifacts.

Keep pull requests narrow and explain the user-visible behavior, security
impact, and verification performed. Sign commits with `git commit -s` to
certify the [Developer Certificate of Origin](https://developercertificate.org/).

Report suspected vulnerabilities through the private process in
[SECURITY.md](SECURITY.md), not a public issue.
