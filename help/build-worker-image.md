---
id: build-worker-image
title: Build a custom worker image for another language
summary: A procedure an MCP assistant follows to build a custom coding worker image for Go, Java, Rust or another language on Wardby's driver base image, check it, and point a Codex coding agent at it with workerImageRef.
audience: operator
tags: [worker-image, custom-image, workerImageRef, toolchain, other-language, go, golang, java, rust, ruby, codex]
appliesTo: ">=0.5.3"
---

# Build a custom worker image for another language

Wardby's own worker images have Node (`toolchain: node`) or Node and Python
3.12 (`toolchain: node-python`). For any other language, build your own image
on top of Wardby's driver base image and set the coding agent's
`codingProfile.workerImageRef` to it. The long-form guide is
[`docs/coding-worker-byo-images.md`](../docs/coding-worker-byo-images.md).

**Codex agents only.** A Claude Code agent runs its commands in Claude's tool
runner, which `workerImageRef` does not change, so a custom image gives a Claude
Code agent no new tools. If the agent's `codingProfile.provider` is
`claude-code`, say so and stop; the user can switch the agent to Codex (the
quickstart sets Codex up with `--coding-provider codex` and an
`OPENAI_API_KEY`).

If you are an assistant connected to Wardby over MCP, follow these steps. Do
them in order, ask the user instead of guessing, and stop at the first failed
prerequisite. Never write into the user's repository; ask where to keep the
Dockerfile (for example a folder outside the repository).

## Step 1: find the toolchain

Read the manifests at the repository root to learn the language and version:
`go.mod` (Go; the `go` line), `pom.xml` or `build.gradle(.kts)` (Java; Maven or
Gradle), `Cargo.toml` and `rust-toolchain.toml` (Rust), `Gemfile` and
`.ruby-version` (Ruby), `composer.json` (PHP), `*.csproj` or `global.json`
(.NET). Also read how the project runs its tests (README, CI workflow, Makefile).
If there are several languages, or the version is unclear, ask the user which
toolchain and version to install.

## Step 2: get the base image digest

Run `npx @wardby/cli@latest doctor` in the Wardby project directory. It prints:

```text
Base image for your own worker images: ghcr.io/wardby/wardby/wardby-coding-worker-driver@sha256:<digest>
```

Use exactly that reference. It matches the Wardby version that runs the agent,
and a worker built on an older driver rejects newer run input. If doctor prints
no such line, this Wardby version is too old: ask the user to upgrade, and stop.

## Step 3: write the Dockerfile

Follow the BYO guide's shape:

```dockerfile
FROM <base image from step 2>
# Install the toolchain: distribution packages, or a pinned official image
# (COPY --from=<image>@sha256:<digest> ...), or ADD --checksum=sha256:<sum> <url>.
RUN apt-get update \
    && apt-get install -y --no-install-recommends <toolchain packages> \
    && rm -rf /var/lib/apt/lists/*
RUN test ! -e /usr/bin/docker \
    && test ! -e /usr/bin/ssh \
    && test ! -e /usr/bin/curl \
    && test ! -e /usr/bin/wget \
    && test ! -e /usr/bin/sudo
USER 10001:10001
ENV NODE_ENV=production HOME=/home/wardby
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/wardby/coding-worker/main.js"]
```

- **Install by pinned version or digest.** Never `latest`, and never pipe a
  download into a shell.
- **Keep the hardening checks.** The image must not contain docker, ssh, curl,
  wget or sudo. If the toolchain really needs one of them, drop only that check
  and tell the user why. The same goes for a C compiler or linker: Rust and
  cgo, for example, need one.
- **Provide the command names the project uses** (for example a `python`
  symlink when the README says `python`), and put the toolchain on `PATH` with
  `ENV`.
- **Bake in dependencies the tests need.** A worker reaches no package registry
  except Wardby's npm and PyPI proxy, so Go modules, Maven or Gradle
  dependencies, crates and gems cannot be downloaded during a run. Pre-fetch
  them at build time (for example `go mod download`,
  `mvn dependency:go-offline` or `cargo fetch`) under a directory outside
  `/home/wardby` and `/tmp`, and rebuild when they change. Ask before copying
  the repository's manifests into the build context.
- **Know the run's filesystem.** The root filesystem is read-only; `/tmp` and
  `/home/wardby` are empty, writable and `noexec` (anything the image put
  there is hidden); `/workspace` is the checkout. A tool that executes binaries
  it builds at test time (such as `go test` or `cargo test`) needs its build
  directory under `/workspace`, and files left in `/workspace` can end up in
  the run's result: tell the user, and ask how they want it handled.

## Step 4: build and check

```sh
docker build --tag wardby-worker-<language>:local <dockerfile folder>
docker run --rm --read-only --tmpfs /tmp:rw,noexec --tmpfs /home/wardby:rw,noexec,uid=10001,gid=10001 --entrypoint sh wardby-worker-<language>:local -c '<toolchain> --version'
```

Check every command the tests need (for example `go version`, `java -version`
and `mvn -v`, `cargo --version`). Fix the Dockerfile until they all work.

## Step 5: choose the image reference

`workerImageRef` must be immutable; a tag is refused.

- **Local quickstart** (the Docker launcher on this machine): use the local
  image ID, `docker image inspect --format '{{.Id}}' wardby-worker-<language>:local`
  (a `sha256:...` value).
- **Hosted Wardby**: push the image to a registry the workers can pull from,
  and use `<registry>/<name>@sha256:<digest>`.

## Step 6: update the builder and try it

1. Call `update_agent` with the coding agent's id and
   `codingProfile: {workerImageRef: "<reference from step 5>"}`. This needs the
   `agents:admin` scope and the admin role; the local operator of a quickstart
   install has both. On a hosted server, ask an administrator if it is refused.
2. Start a small run that exercises the toolchain:
   `trigger_agent {agentId, task: "Run the project's tests and report the results. Change nothing."}`.
3. Read the result with `get_run` and report to the user what ran, what passed
   and what failed. A command that is missing, or a dependency that could not
   be fetched, means going back to step 3.

To undo it, call `update_agent` with `codingProfile: {workerImageRef: null}`.

Related: [Use local git repositories](local-repositories.md),
[Approve packages for coding agents](coding-packages.md),
[Troubleshoot coding workers](troubleshooting/coding-workers.md) and
[Get started](getting-started.md).
