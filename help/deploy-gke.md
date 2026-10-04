---
id: deploy-gke
title: Deploy Wardby on GKE Autopilot
summary: Use the supported Google Cloud path for a private database, isolated coding workers, and HTTPS ingress.
audience: operator
tags: [deployment, gke, gcp, kubernetes, production, secrets, jira]
appliesTo: >=0.2.1
---

# Deploy Wardby on GKE Autopilot

The supported Google Cloud deployment creates a GKE Autopilot cluster, private
Cloud SQL for PostgreSQL, Artifact Registry, HTTPS Gateway, Google Secret
Manager synchronization, and isolated gVisor-backed **Codex** coding-worker
pods. It also applies namespace RBAC and default-deny network policies.

Use a dedicated billed project, a hostname you control, remote Terraform state,
and a GitHub App installed only on repositories that agents need. Review
Terraform's plan and set cloud budgets before applying it: the deployment
creates billable resources.

The deployment process is:

1. Install `gcloud`, Terraform, Docker with `linux/amd64` support, `kubectl`,
   Helm, Node.js 24, and authenticate to the target project.
2. Configure `deploy/gke/terraform.tfvars`, apply Terraform, and prepare the
   Gateway's address, certificate map, Cloud Armor policy, and DNS record.
3. Put first-time values in an untracked `.env.local`; `deploy/gke/up.sh`
   seeds Secret Manager without overwriting existing production values.
   Jira settings are optional there, all or none; see [Jira](jira.md).
4. Run `HOSTNAME=wardby.example.com deploy/gke/up.sh`, then verify DNS,
   certificate issuance, database IAM bootstrap, and service health.

When a release changes `deploy/gke/database-grants.sql`, re-run the database
grants bootstrap **before** deploying that release, so the proxy role can
already write the tables and columns it adds (such as per-model usage for
[cost attribution](cost-attribution.md), or a run's live turn count). Until the
grants are applied, the coding proxy's writes are refused and coding runs fail.

Claude Code's two-container executor is currently Docker-only; Kubernetes
coding workers use the Codex path. Configure an identity provider and GitHub
App before allowing people to use the public endpoint.

Follow the complete, ordered guide at
[`docs/getting-started-gke.md`](../docs/getting-started-gke.md). It includes
the precise IAM, DNS, bootstrap, upgrades, and teardown steps.
