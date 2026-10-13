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
`WARDBY_VIEWER=0` to skip it. In the viewer, add the server
`http://127.0.0.1:8080` and sign in with the key in `.tilt/dev-login-key`.

Tilt also starts Prometheus and Grafana (`http://127.0.0.1:3000`,
`admin` / `wardby-local-only`); set `WARDBY_OBSERVABILITY=0` to skip them. Only
the coding proxy emits metrics, so the dashboards cover coding runs. The coding
proxy needs `OPENAI_API_KEY` (from the shell, `.env.local` or `.env`); a missing
`ANTHROPIC_API_KEY` is replaced by a placeholder, so Claude coding runs would fail.
Without `OPENAI_API_KEY`, Tilt warns and skips the stack (`WARDBY_OBSERVABILITY=1`
makes that an error instead).

The `wardby` resource has a **Run a task** button in the Tilt UI. Fill in the
task, model, budget cap (at most 5 USD) and a name prefix; it creates a fresh
native agent and runs it once, streaming the output to the resource's log. It
makes a real, billed model request, and the run appears in the viewer. The
button comes from Tilt's `uibutton` extension, which Tilt fetches on first load.

The server listens on `http://127.0.0.1:8080` (`WARDBY_MCP_PORT` to change it);
the MCP endpoint is `/mcp`. Use `127.0.0.1`, not `localhost`: the server rejects
any other Host.

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
