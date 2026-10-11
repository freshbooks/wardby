# Password-less database access. Each workload's Kubernetes service account
# gets its own IAM role through EKS Pod Identity, and each role may mint RDS IAM
# tokens for exactly one Postgres user. What each user may do inside the
# database is decided by the grants bootstrap, not here: Terraform creates no
# Postgres users.

locals {
  # Workload -> Kubernetes service account (fixed by the manifests; module.test.mjs checks).
  database_identities = {
    app      = "wardby-control-plane"
    migrator = "wardby-migrator"
    proxy    = "wardby-coding-proxy"
    gateway  = "wardby-native-gateway"
  }

  database_users = { for k, _ in local.database_identities : k => "${var.name_prefix}-${k}" }
}

resource "aws_iam_role" "database" {
  for_each           = local.database_identities
  name               = "${var.name_prefix}-db-${each.key}"
  assume_role_policy = local.pod_identity_trust_policy
}

resource "aws_iam_role_policy" "database_connect" {
  for_each = local.database_identities
  name     = "rds-db-connect"
  role     = aws_iam_role.database[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "rds-db:connect"
      Resource = "arn:${local.partition}:rds-db:${var.region}:${local.account_id}:dbuser:${aws_db_instance.main.resource_id}/${local.database_users[each.key]}"
    }]
  })
}

resource "aws_eks_pod_identity_association" "database" {
  for_each        = local.database_identities
  cluster_name    = aws_eks_cluster.main.name
  namespace       = var.namespace
  service_account = each.value
  role_arn        = aws_iam_role.database[each.key].arn

  depends_on = [aws_eks_addon.pod_identity_agent]
}
