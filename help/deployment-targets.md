---
id: deployment-targets
title: Choose a deployment target
summary: Pick the supported Wardby deployment path and understand its operational boundary.
audience: operator
tags: [deployment, docker, gke, aws, production]
appliesTo: >=0.2.1
---

# Choose a deployment target

Wardby has one local path and two production-ready deployment shapes:

- **Local development:** `wardby quickstart` runs the control plane locally
  with its portable PostgreSQL container. It is the best place to evaluate,
  develop agents, and connect a local Codex or Claude Code client.
- **Production container baseline:** run the published production image with
  PostgreSQL, HTTPS ingress, durable storage, backups, and an operator-owned
  identity provider. The Compose and Caddy configuration is a reference
  baseline, not a managed platform.
- **Google Kubernetes Engine Autopilot:** the supported Google Cloud path. It
  provisions GKE, private-IP Cloud SQL, Artifact Registry, isolated Codex
  workers, HTTPS Gateway, and GCP-native secret and network controls. See
  [Deploy on GKE](deploy-gke.md).

AWS is supported as a portable runtime target and has a Bedrock Claude adapter,
but Wardby does not ship a native AWS deployment module. Other cloud providers
can run the production container image with equivalent database, ingress,
identity, secret, isolation, and observability controls; that infrastructure is
operator-owned.

The older `deploy/gcp` Cloud Run module is deprecated. Do not choose it for a
new installation.

Before going live, complete the deployment security checklist and make a
backup, upgrades, alerting, and incident-response plan. Read
[`docs/getting-started.md`](../docs/getting-started.md) for the local and
container setup, and [`docs/security-deployment.md`](../docs/security-deployment.md)
for the production controls.
