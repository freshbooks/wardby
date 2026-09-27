---
id: observability
title: Monitor Wardby
summary: Scrape private Prometheus metrics and build production alerting around the coding proxy and run lifecycle.
audience: operator
tags: [observability, prometheus, grafana, metrics, operations]
appliesTo: >=0.2.1
---

# Monitor Wardby

When `METRICS_BIND` is configured, Wardby's coding proxy exposes Prometheus
metrics at `/metrics`. Keep that endpoint on a private network and permit only
your collector to scrape it. Metrics cover proxy requests, errors, latency,
audit events, model cost, reserved and actual budget spend, coding outcomes,
and Node.js process health; they intentionally exclude prompts, repository
content, credentials, diffs, raw worker output, and run identifiers.

For a local dashboard stack, run:

```sh
npm run observability:up
npm run observability:smoke
```

This starts Prometheus and Grafana locally. Use `npm run observability:down`
when finished.

In production, configure your own Prometheus-compatible collector, retention,
private connectivity, alerts, and SLOs. GCP operators can use the Ops Agent or
Managed Service for Prometheus; AWS operators can use the CloudWatch Agent
Prometheus collector. Wardby's reference cloud deployments do not provision
them, and application/MCP metrics are currently narrower than coding-proxy
metrics.

Alert on proxy failures, budget cutoffs, cleanup failures, stalled runs, and
sustained latency or memory growth. Wardby's database remains the source of
truth for runs, budgets, and accounting.

Read [`docs/observability.md`](../docs/observability.md) for configuration and
the full production checklist.
