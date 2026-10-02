# Admin viewer API

The viewer API is a read-only HTTP API that shows what is running in a Wardby
deployment: runs, sub-agent trees, what triggered each run, its outcomes
(pull requests, comments, checks), and coding-run services. It is built for
dashboards and desktop viewers that want a live picture of the whole
deployment.

It is **deployment-wide**. Unlike the MCP tools, which show a caller their own
and public agents, the viewer shows **every owner's** runs. For that reason it
requires the privileged `admin:view` scope, and that scope is granted only by
the `admin` role.

## Access

A caller needs an access token for the Wardby MCP resource that carries the
`admin:view` scope, and the Wardby `admin` role. Send it as
`Authorization: Bearer <token>`.

- **Self-hosted sign-in:** the `admin` role grants `admin:view`. A client
  requests the scope during sign-in like any other.
- **External identity provider (delegating mode):** define the `admin:view`
  scope in the provider and map it the same way as `agents:admin`, and map the
  provider's admin group to the Wardby `admin` role. When you upgrade an
  existing deployment, define the scope before deploying: clients that request
  every advertised scope otherwise fail with `invalid_scope`. See
  [getting-started-identity-provider.md](getting-started-identity-provider.md).

Native and desktop clients sign in with PKCE and a loopback redirect. In
self-hosted mode a client may register a loopback redirect
(`http://127.0.0.1/...`, `http://[::1]/...` or `http://localhost/...`) and then
use any port at sign-in, as RFC 8252 describes. Everything except the port
must match the registered redirect.

## Endpoints

All three endpoints accept only `GET`.

| Status | Meaning                                                           |
| ------ | ----------------------------------------------------------------- |
| `401`  | No valid access token.                                            |
| `403`  | The token lacks `admin:view`, or the caller lacks the admin role. |
| `400`  | `invalid_since` or `invalid_limit` (graph only).                  |
| `404`  | Unknown run id (run detail only).                                 |
| `405`  | A method other than `GET`.                                        |

### `GET /admin/api/graph`

A snapshot of runs and their relationships.

| Query parameter | Values                                                   | Default |
| --------------- | -------------------------------------------------------- | ------- |
| `since`         | `15m`, `1h`, `6h`, `24h`, `7d`, or an ISO-8601 timestamp | `1h`    |
| `limit`         | An integer from 1 to 2000                                | `500`   |

The snapshot includes runs that started in the window **or** are still pending
or running, plus all of their ancestors, so a sub-agent tree is never cut off
from its root. When more runs match than `limit`, the response sets
`truncated`.

### `GET /admin/api/runs/<id>`

One run in full: the graph fields plus the run's final text and error. For
coding runs, services report the **names** of their environment variables
only, never values. An unknown id returns `404`.

### `GET /admin/api/events`

A Server-Sent Events stream (`text/event-stream`) of live changes. Frames:

| Frame                                            | Meaning                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `retry: 3000`                                    | Suggested client reconnect delay in milliseconds.                                              |
| `event: hello`                                   | Sent first. Data is `{"connected": <bool>}`: whether the server's live-event connection is up. |
| `event: run`, `event: service`, `event: outcome` | A run, coding-run service, or outcome changed. Each carries an `id:` line.                     |
| `event: resync`                                  | The live-event connection was lost and restored. Events may have been missed.                  |
| `: ping`                                         | Comment sent every 15 seconds to keep the connection open.                                     |

Event payloads are small and never include final text; fetch
`/admin/api/runs/<id>` for detail. A `run` event carries the run's status,
turn and token counts, cost and finish time. A `service` event carries the
service name, its state and the attempt count. An `outcome` event carries only
the run id and the outcome source, so refetch the run to see what changed.

**There is no replay.** Load `/admin/api/graph` first, then apply events. On
`resync`, and on every reconnect, refetch `/admin/api/graph` rather than
trying to resume.

Live events come from Postgres `NOTIFY`. Each server replica holds one
database connection for them, opened only while at least one client is
subscribed.

## Response schemas

JSON Schemas for every response and event are in `src/viewer/schemas/` of the
source tree (`graph-snapshot.schema.json`, `run-detail.schema.json`,
`viewer-event.schema.json`). Regenerate them with `npm run build:viewer-schemas`.

## Proxies and load balancers

The event stream is a long-lived response. Any proxy or load balancer in front
of Wardby must allow responses that last as long as a client stays connected
and must not buffer `text/event-stream`. Wardby sends `Cache-Control: no-store`
and `X-Accel-Buffering: no` on the stream. The reference GKE Gateway overlay
raises the backend timeout to 3600 seconds (`GCPBackendPolicy`
`spec.default.timeoutSec`); clients reconnect and resync when a stream ends.
