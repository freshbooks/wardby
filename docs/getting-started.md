# Getting started

This guide gets a local Wardby control plane running without installing
PostgreSQL or cloning the Wardby repository. Wardby keeps its database and
configuration isolated from the application in which you run it.

For a shared deployment with isolated Kubernetes coding workers, use the
[GKE getting-started guide](getting-started-gke.md).

## Requirements

- Node.js 24 or newer.
- Docker with Docker Compose v2.
- An OpenAI or Anthropic API key.
- Optional: Codex or Claude Code, if you want `quickstart` to register Wardby
  as an MCP server.

## Run quickstart

From the repository where you want to use Wardby:

```sh
npx --yes @wardby/cli@latest quickstart
```

The guided command:

1. checks Node, Docker, Docker Compose, and the Docker daemon;
2. creates a private `.wardby/.env` and project state;
3. adds `.wardby/` to the repository's `.gitignore`;
4. starts PostgreSQL 16 in Docker on the first available local port beginning
   at `55432`;
5. applies Wardby's packaged Prisma migrations;
6. creates the `hello-wardby` sample agent with a `$1` maximum run budget;
7. asks before making the billed model request;
8. optionally sets up coding and review agents against a local git repository
   (see [Coding agents on a local repository](#coding-agents-on-a-local-repository));
   and
9. optionally registers the local stdio MCP server with Codex, Claude Code, or
   both.

Provider credentials and `SECRET_APP_KEY` are written with owner-only file
permissions. They are not printed, passed as command-line arguments, or added
to the application's own `.env` files.

## Unattended setup

Automation must explicitly accept the billed demo with `--yes`:

```sh
OPENAI_API_KEY="..." npx --yes @wardby/cli@latest quickstart \
  --provider openai \
  --model gpt-5.6-luna \
  --budget 1 \
  --client codex \
  --non-interactive \
  --yes
```

Use `--skip-demo` to prepare the database without making a provider request.
This is useful for CI and package verification:

```sh
npx --yes @wardby/cli@latest quickstart \
  --provider openai \
  --non-interactive \
  --skip-demo
```

## Operate the local installation

Run these from the same project directory. Set `WARDBY_PROJECT_DIR` to that
directory when invoking Wardby from somewhere else.

```sh
npx --yes @wardby/cli@latest doctor
npx --yes @wardby/cli@latest status
npx --yes @wardby/cli@latest logs --tail 100
npx --yes @wardby/cli@latest down
```

`down` stops PostgreSQL but preserves its named volume. Removing the database
is intentionally explicit:

```sh
npx --yes @wardby/cli@latest down --volumes
```

`quickstart` is safe to rerun. It reuses the project identity, port, secrets,
and database volume, reapplies idempotent migrations, and updates the sample
agent instead of creating duplicates.

## MCP configuration

Passing `--client codex`, `--client claude`, or `--client both` lets quickstart
register Wardby after showing the choice interactively. The generated stdio
entry launches the same package version and sets `WARDBY_PROJECT_DIR`, so the
MCP process finds this project's private Wardby configuration regardless of the
client's current working directory.

After connecting, try:

> List my Wardby agents, show the latest run and its actual cost, then create a
> new agent with a maximum budget of $0.50. Do not run it yet.

### Reasoning effort

A native agent can set `effort` (`low`, `medium`, `high`, `xhigh`, or `max`)
through `create_agent`, `update_agent`, or `wardby agent create --effort`. It is
sent on every model call and trades depth of reasoning against latency and
output-token cost; lower levels are faster and cheaper per turn. Leave it unset
to use the provider's default. Wardby rejects a level the agent's model does not
accept, including when you later change the model (clear it with
`effort: null`). Effort currently applies to direct Anthropic API models that
support it; OpenAI and Bedrock models accept no effort setting, and coding
agents do not use it.

## Coding agents

The first-run demo proves native model routing, budget admission, persistence,
and accounting. It does not install a GitHub App or start any worker.

Coding agents require the stronger boundary described in
[Coding-agent setup](coding-agent-setup.md): an immutable worker image, a
trusted coding proxy, and either Docker or Kubernetes as the job launcher. For
GitHub repositories they also need a dedicated GitHub App. Run
`wardby coding preflight` before enabling a production repository.

### Coding agents on a local repository

To try a coding agent and a review agent without a GitHub App, quickstart can
point them at a git repository on your machine. After the sample agent it asks
"Set up coding + review agents against a local git repo?"; the default is no.
This step needs Docker, and an `OPENAI_API_KEY` (Codex) or `ANTHROPIC_API_KEY`
(Claude Code) for the coding agent. It:

1. asks which folders to trust (it offers the git root of the current
   directory) and writes them to `.wardby/.env` as `LOCAL_REPO_ROOTS`, together
   with `JOB_LAUNCHER=docker`;
2. gets the images: the runtime and coding worker images, plus (for Claude Code)
   the Claude worker and tool-runner images, pulled by digest from a published
   release or built from a wardby source checkout. Choosing Codex skips the
   Claude images. Set `WARDBY_RUNTIME_IMAGE` and `CODING_WORKER_IMAGE` (and
   `CODING_CLAUDE_WORKER_IMAGE` plus `CODING_CLAUDE_TOOL_RUNNER_IMAGE` for
   Claude Code) to use images of your own;
3. starts the coding proxy and runs the coding preflight;
4. creates `local-builder` (a coding agent, $2 budget) and `local-reviewer` (a
   review agent, $1 budget) for a repository in the trusted folders (a trusted
   folder that is a git repository, or one directly inside it; with several,
   quickstart asks, or non-interactively uses the first in sorted order and
   prints it. Re-run with `--trust <repo>` to choose another: folders passed on
   a run take precedence over saved ones); and
5. prints two `trigger_agent` calls: one asks `local-builder` for a change, the
   other asks `local-reviewer` to review the branch `wardby/run-<run id>` the
   run pushed into your repository.

**Trust model.** Wardby only touches repositories inside the folders you trust.
Agents see committed history only: untracked files such as `.env.local` never
leave your machine. A run never changes your working tree or the branch you have
checked out; its result is a new branch `wardby/run-<run id>` in the repository,
and the repository's own receive hooks run when wardby pushes it.

If the repository has no `.wardby/services.yaml`, quickstart offers a starter
one (PostgreSQL and/or Redis) and commits it to the branch
`wardby/quickstart-services` without touching your working tree or checked-out
branch. Merge that branch, or set the agent's `baseRef` to it. "The default
branch" for these agents is the branch checked out when quickstart runs. If the
repository already has a services file, quickstart prints what it declares, or
why it is invalid.

Options for unattended use:

```sh
OPENAI_API_KEY="..." npx --yes @wardby/cli@latest quickstart \
  --non-interactive --yes \
  --coding --trust ~/projects/my-repo \
  --coding-provider codex \
  --starter-services postgres
```

- `--coding` runs the step without asking and `--no-coding` skips it. With
  `--non-interactive` the step runs only with `--coding`.
- `--trust <dir>` names a trusted folder; repeat it for several. Folders trusted
  by an earlier run are kept. Non-interactive runs need at least one.
- `--coding-provider codex|claude-code` picks the coding agent; by default it
  uses the provider whose key is available.
- `--starter-services postgres,redis|none` answers the starter-file question.

`doctor` and `status` then also report the trusted folders, the worker image,
the coding proxy, and each local agent's repository, and `down` stops the proxy
along with the database. See
[Local repositories](coding-agent-setup.md#local-repositories) for what a local
run does, its requirements (the server must run on the same machine as the
folders) and its limits (no submodules or Git LFS).

## Your first agents

[Agent recipes](agent-recipes.md) gives two complete, copyable setups: an
architecture keeper and a builder per language. They go beyond the quickstart,
which runs native agents only. They require Wardby 0.4.0 or later. They need the
GitHub App, worker image, and job launcher from
[Coding-agent setup](coding-agent-setup.md). Their event triggers need GitHub to
reach your instance at a public HTTPS URL.

The assistant the quickstart connected can walk you through either recipe. Ask it
"Set up the Wardby architecture keeper for this repository" or "Set up a Wardby
builder for this repository"; it follows the `agent-recipes` help article.

## Next steps

- [Agent recipes](agent-recipes.md)
- [Runtime architecture](architecture-runtime.md)
- [Coding-agent setup](coding-agent-setup.md) and its
  [local repositories](coding-agent-setup.md#local-repositories) section
- [Bring your own identity provider](getting-started-identity-provider.md)
- [Observability](observability.md)
- [GKE deployment](getting-started-gke.md)
- [Security deployment guide](security-deployment.md)
