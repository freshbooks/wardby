# Native sandbox

By default a native agent runs inside the Wardby server process: its turn loop
and any user tool code you attach execute next to the database connection, the
LLM credentials, and every other agent's runs. **Sandbox mode** moves the whole
turn loop and the agent's user tools into a single-use Docker container that
holds no credentials, no database access, no Docker socket, and no network
except one internal path to a separate **native gateway**.

Use it when a native agent runs tool code or prompts you do not fully trust, for
example tools written by people other than the operators, or agents that fetch
and process untrusted content. Leave agents in the default `control-plane` mode
when you trust the tools and want the simplest deployment.

Sandbox mode applies to native agents only. Coding agents have their own
isolation model; see [Coding-worker isolation](coding-worker-isolation.md).

## What is isolated and what is not

| Component                 | Trusted? | Where it runs                      |
| ------------------------- | -------- | ---------------------------------- |
| Wardby server / scheduler | Yes      | Your host, VM, or cluster          |
| Native gateway            | Yes      | A separate container you operate   |
| Postgres, LLM provider    | Yes      | Reachable only from server/gateway |
| Agent turn loop (worker)  | No       | Single-use container, one per run  |
| User tool code (worker)   | No       | The same worker container          |

The worker container:

- has no LLM keys, secrets, database URL, or Docker socket, and receives only a
  run-scoped capability on its standard input (never in its environment,
  arguments, labels, or `docker inspect` output);
- runs as non-root (uid 10001) on a read-only root filesystem with a
  size-capped `/tmp` (no exec), all Linux capabilities dropped,
  `no-new-privileges`, and CPU, memory, and PID limits;
- sits on an internal Docker network created for that run alone, shared only
  with the gateway container, with no route to the internet, the host, or any
  other run.

Everything the worker needs from the outside world (model calls, the built-in
tools, and tool access to datastores, secrets, and outbound fetch) goes through
the gateway, which enforces each tool attachment's grants. A worker can only
ask for what the agent's attachments already allow.

Containers are defense in depth, not a virtual-machine boundary. Run the Docker
host on a machine that holds no production credentials beyond what the server
and gateway need.

## Topology

```
              Docker host
 +---------------------------------------------------------+
 |  wardby serve  (server + scheduler)                     |
 |     |  docker run / network create / network connect    |
 |     v                                                   |
 |  per-run internal network  (no external route)          |
 |   +--------------------+        +--------------------+  |
 |   | native worker      |  HTTP  | native gateway     |  |
 |   | (no credentials)   +------->| wardby-native-     |--+--> LLM provider
 |   | single-use         |        | gateway :8790      |--+--> Postgres
 |   +--------------------+        | (credentials, DB)  |  |
 |                                 +--------------------+  |
 +---------------------------------------------------------+
```

For each run the server creates a new internal network, connects the gateway
container to it under the alias `wardby-native-gateway`, and starts the worker
on it. When the run ends the worker, the network, and the gateway's membership
of it are removed.

The gateway is stateless: all state is in Postgres. You can restart it while
runs are in flight; workers retry their calls. It must not be given the Docker
socket, because workers can reach it.

## Requirements

- Docker on the host that runs `wardby serve` (or `wardby scheduler`). The
  server launches workers with the `docker` CLI, so its user must be able to
  use the Docker daemon.
- A running native gateway container (below) on the same Docker host, with
  access to the same Postgres database as the server.
- The `wardby-native-worker` image, pinned by digest or local image id.
- A running `wardby serve` or `wardby scheduler`. Sub-agents of a sandboxed run
  are started by the scheduler leader (see [Sub-agents](#sub-agents)).

## Set up with Docker

### 1. Choose the worker image

Releases publish the image to the GitHub Container Registry as
`ghcr.io/<org>/wardby-native-worker`. The exact digest-pinned reference for the
installed version is listed as `nativeWorker` in `dist/quickstart-images.json`
inside the npm package. Use that reference as-is:

```dotenv
NATIVE_SANDBOX_WORKER_IMAGE=ghcr.io/your-org/wardby-native-worker@sha256:replace-with-digest
```

The image must be immutable: a `repo@sha256:...` digest or a local image id.
A mutable tag such as `:latest` is refused with
[`native_sandbox_image_not_pinned`](../help/errors/native-sandbox-image-not-pinned.md).

To build it yourself from a repository checkout:

```bash
npm run native-worker:image:local
docker image inspect --format '{{.Id}}' wardby-native-worker:local
```

Use the printed `sha256:...` image id as `NATIVE_SANDBOX_WORKER_IMAGE`. A local
id must already exist on the Docker host; a digest reference is pulled once if
missing.

### 2. Run the native gateway

The gateway is the same Wardby build as the server, started with the
`native-gateway` command. It needs the server's database, LLM, secrets, and
integration settings, and **no Docker access**.

| Gateway variable        | Purpose                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| `NATIVE_GATEWAY_LISTEN` | `host:port` to listen on. Default `0.0.0.0:8790`.                        |
| `DATABASE_URL`          | The same database the server uses.                                       |
| LLM provider keys       | The same provider settings as the server (for example `OPENAI_API_KEY`). |
| `SECRET_APP_KEY`        | Same value as the server, so tools can read their bound secrets.         |
| Integration settings    | The same repository-host and issue-tracker settings as the server.       |

If sandboxed agents delegate to coding agents, give the gateway the same
coding image settings as the server (for example `CODING_WORKER_IMAGE`); the
gateway only resolves them, it never starts coding workers.

For local development, the repository ships a compose overlay
(`deploy/local/docker-compose.native-sandbox.yml`) that runs the gateway next to
the local Postgres from `deploy/local/docker-compose.yml`:

```bash
docker compose -f deploy/local/docker-compose.yml -f deploy/local/docker-compose.native-sandbox.yml --env-file .env.local up -d --build native-gateway
```

The overlay names the container `wardby-native-gateway`, passes the database
URL for the compose network and your LLM keys from the environment file. It
runs with a read-only root filesystem and all capabilities dropped, and mounts
no Docker socket.
It defines its own health check against `/healthz`.

For other deployments, run `wardby native-gateway` in a container built from
the same image as the server, on the same Docker host, with any container
name you choose, and give that name to the server in the next step. Do not
publish its port to the internet; only the per-run networks and your own
health checks need to reach it.

### 3. Configure the server

Add these to the server's environment (`wardby serve` or `wardby scheduler`),
then restart it:

```dotenv
NATIVE_SANDBOX_LAUNCHER=docker
NATIVE_SANDBOX_WORKER_IMAGE=ghcr.io/your-org/wardby-native-worker@sha256:replace-with-digest
NATIVE_GATEWAY_CONTAINER=wardby-native-gateway
```

| Variable                      | Required | Default                                                    | Purpose                                                                          |
| ----------------------------- | -------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `NATIVE_SANDBOX_LAUNCHER`     | Yes      | unset (sandbox off)                                        | Set to `docker` to enable sandbox mode. Independent of `JOB_LAUNCHER`.           |
| `NATIVE_SANDBOX_WORKER_IMAGE` | Yes      |                                                            | Pinned worker image: `repo@sha256:...` or a local image id.                      |
| `NATIVE_GATEWAY_CONTAINER`    | Yes      |                                                            | Name of the running gateway container the server connects to each run's network. |
| `NATIVE_GATEWAY_URL`          | No       | `http://wardby-native-gateway:8790/native-gateway/v1/call` | What workers dial. Change only if the gateway listens on another port.           |
| `NATIVE_SANDBOX_CPUS`         | No       | `1`                                                        | CPU limit per worker.                                                            |
| `NATIVE_SANDBOX_MEMORY_MB`    | No       | `512`                                                      | Memory limit per worker (swap is disabled).                                      |
| `NATIVE_SANDBOX_PIDS`         | No       | `128`                                                      | Process limit per worker.                                                        |

A missing required variable, or a launcher other than `docker`, stops the
server at startup with a message naming the variable. When
`NATIVE_SANDBOX_LAUNCHER` is unset, sandbox mode is off and any sandbox-mode
run fails closed (see [Failure modes](#failure-modes)).

`JOB_LAUNCHER` (coding agents) is a separate setting; you can enable either,
both, or neither.

### 4. Set an agent's mode

Each native agent has a `nativeExecutionMode` setting:

- `control-plane` (default): the run executes in the server process.
- `sandbox`: the run executes in a worker container as described above.

Set it with the MCP tools `create_agent` or `update_agent` (field
`nativeExecutionMode`, native agents only), or in an import bundle. Setting
`sandbox` is refused while the server has no native sandbox configured.

Each run keeps the mode it started with. Changing an agent affects only the
runs that start afterwards.

## Limits and deadline

- Each worker is limited by `NATIVE_SANDBOX_CPUS`, `NATIVE_SANDBOX_MEMORY_MB`,
  and `NATIVE_SANDBOX_PIDS`, with a 64 MiB `/tmp`. Raise the limits if tools
  run out of memory or processes.
- A sandbox run has a maximum lifetime of 60 minutes. Past it the worker is
  stopped and the run fails with `native_sandbox_deadline_exceeded`.
- The agent's own turn and budget limits still apply as for any native agent.

## Sub-agents

A sandboxed run can delegate to sub-agents, including several in parallel.
Sub-agents of a sandboxed run are always **managed runs**: the gateway records
the delegation, and the server's scheduler leader starts the child on its next
tick (about every 10 seconds). Each delegation therefore adds up to about ten
seconds of start-up latency, and `wardby serve` or `wardby scheduler` must be
running or the child never starts.

A child runs in its own configured mode (a `control-plane` child runs in the
server, a `sandbox` child in its own worker). Cancelling a parent run stops its
open children.

## Budget behavior

The gateway is the budget authority for sandboxed runs. Before each model call
it reserves that call's worst-case cost against the run's budget (and any
budget group), calls the provider, then settles at the actual usage. A call the
remaining budget cannot cover is refused and the run ends `budget_exhausted`
instead of overspending. The worker cannot raise or bypass its budget because it
never talks to the provider directly.

## Failure modes

| Error code                                                                               | Meaning                                                                                           | What to do                                                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`native_sandbox_unavailable`](../help/errors/native-sandbox-unavailable.md)             | Agent is in `sandbox` mode but the server has no native sandbox. Fails before any spend.          | Configure the sandbox (steps above) or set the agent back to `control-plane`.         |
| [`native_sandbox_worker_exited`](../help/errors/native-sandbox-worker-exited.md)         | The worker ended without producing a result.                                                      | Check the tool code and the worker's memory and PID limits; run again.                |
| [`native_sandbox_deadline_exceeded`](../help/errors/native-sandbox-deadline-exceeded.md) | The run passed its 60-minute maximum; the worker was stopped.                                     | Split the work into smaller runs or sub-agents.                                       |
| [`native_sandbox_worker_lost`](../help/errors/native-sandbox-worker-lost.md)             | The worker container disappeared (for example its Docker host restarted). It is never relaunched. | Trigger the run again; check the Docker host's stability.                             |
| [`native_sandbox_image_not_pinned`](../help/errors/native-sandbox-image-not-pinned.md)   | `NATIVE_SANDBOX_WORKER_IMAGE` is a mutable tag.                                                   | Use a `repo@sha256:...` digest or a local image id.                                   |
| [`native_sandbox_docker_failed`](../help/errors/native-sandbox-docker-failed.md)         | A Docker command (pull, network create, connect, run) failed.                                     | Read the message, then check the Docker daemon, image availability, and gateway name. |

A run's error appears in its `error` field in `get_run` and `list_runs`.

## Roll back

Set the agent back to `control-plane` with `update_agent`. Runs already started
keep their mode until they finish. To switch sandbox mode off for the whole
deployment, unset `NATIVE_SANDBOX_LAUNCHER`; sandbox-mode agents then fail
closed with `native_sandbox_unavailable` rather than running unisolated, so move
them back to `control-plane` first if they should keep running.

## Troubleshooting

- **Gateway health.** `GET /healthz` on the gateway returns `{"ok":true}` when
  its database answers and 503 otherwise. From the Docker host:
  `docker exec wardby-native-gateway node -e "fetch('http://127.0.0.1:8790/healthz').then(r => r.text()).then(console.log)"`.
- **List worker containers.** Workers and networks carry the label
  `io.wardby.component=native-worker`:
  `docker ps --all --filter label=io.wardby.component=native-worker`.
  The server removes finished workers and, at startup, sweeps leftovers whose
  runs have ended or passed their deadline.
- **Check a run.** Call `get_run` for the run's status and error code, then use
  the matching error article from `search_help` or `get_help_article`.
- **Workers cannot reach the gateway.** Confirm `NATIVE_GATEWAY_CONTAINER`
  matches the running container's name exactly and that the gateway listens on
  the port in `NATIVE_GATEWAY_URL` (default 8790).
- **Sub-agents never start.** Confirm `wardby serve` or `wardby scheduler` is
  running; the scheduler leader starts them.
- **Tool code fails inside the sandbox.** The worker has no network except the
  gateway and a read-only filesystem apart from `/tmp`; tools must use the
  provided fetch, datastore, and secret functions.

See also [Security deployment](security-deployment.md) and the
[runtime architecture](architecture-runtime.md).
