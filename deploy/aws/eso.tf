# The External Secrets Operator reads the secrets above into Kubernetes Secrets.
#
# With EKS Pod Identity, ESO authenticates as its own controller service
# account: a SecretStore cannot name another service account (ESO cannot
# impersonate a Pod Identity-bound account), so the SecretStore has no auth
# section. Every SecretStore in the cluster therefore reads with this role,
# which is why it may read exactly this module's secrets and nothing else, and
# why who may create SecretStores (Kubernetes RBAC) is part of the boundary.

resource "aws_iam_role" "external_secrets" {
  name               = "${var.name_prefix}-external-secrets"
  assume_role_policy = local.pod_identity_trust_policy
}

resource "aws_iam_role_policy" "external_secrets_read" {
  name = "read-deployment-secrets"
  role = aws_iam_role.external_secrets.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = [for s in aws_secretsmanager_secret.deployment : s.arn]
    }]
  })
}

resource "aws_eks_pod_identity_association" "external_secrets" {
  cluster_name    = aws_eks_cluster.main.name
  namespace       = var.eso_namespace
  service_account = var.eso_service_account
  role_arn        = aws_iam_role.external_secrets.arn

  depends_on = [aws_eks_addon.pod_identity_agent]
}
