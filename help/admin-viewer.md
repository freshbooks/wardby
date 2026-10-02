---
id: admin-viewer
title: Watch live runs with the admin viewer API
summary: Read-only, deployment-wide live view of runs, sub-agent trees, triggers, outcomes and coding-run services for admins (admin:view).
audience: operator
tags: [viewer, admin, runs, live, sse, monitoring]
appliesTo: ">=0.4.0"
---

# Watch live runs with the admin viewer API

The admin viewer API is a read-only HTTP API for dashboards and desktop
viewers. It shows every owner's runs across the deployment: sub-agent trees,
what triggered each run, its outcomes (pull requests, comments, checks), and
coding-run services, with a live event stream.

It requires the Wardby `admin` role and the `admin:view` scope, which only the
`admin` role grants. In delegating mode, define `admin:view` in your identity
provider and map it like `agents:admin`. See
[Configure identity and privileged access](identity-and-access.md).

Endpoints, all `GET`:

- `/admin/api/graph?since=1h&limit=500`: a snapshot of runs in a time window.
- `/admin/api/runs/<id>`: one run in full, including its final text and error.
- `/admin/api/events`: a Server-Sent Events stream of live changes.

The stream has no replay: open the event stream first, then load the graph,
and refetch the graph on every `resync` event and after any reconnect. `hello`
and `status` events report whether live events are flowing. Proxies and load balancers in front of Wardby
must allow long-lived responses and not buffer `text/event-stream`.

For parameters, status codes, frame formats and schemas, follow
[`docs/viewer-api.md`](../docs/viewer-api.md).
