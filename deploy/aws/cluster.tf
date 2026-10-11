# The EKS cluster. Standard mode with managed node groups (nodegroups.tf), not
# Auto Mode: Auto Mode's nodes cannot run an extra container runtime, and
# coding-run pods require gVisor (the eks platform profile refuses anything else).

resource "aws_iam_role" "cluster" {
  name = "${var.name_prefix}-eks-cluster"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
    }]
  })
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonEKSClusterPolicy"
}

# The log group EKS writes control-plane logs to. Created here, before the
# cluster, so it has a retention period and is deleted with the module; left to
# EKS, it would be created on first use, kept forever and left behind on destroy.
resource "aws_cloudwatch_log_group" "cluster" {
  name              = "/aws/eks/${var.name_prefix}/cluster"
  retention_in_days = var.cluster_log_retention_days
}

resource "aws_eks_cluster" "main" {
  name     = var.name_prefix
  version  = var.kubernetes_version
  role_arn = aws_iam_role.cluster.arn

  # EKS installs no self-managed vpc-cni, kube-proxy or coredns: the managed
  # add-ons below (and coredns in nodegroups.tf) are the only ones, so there is
  # nothing for them to conflict with. Changing this later replaces the cluster.
  bootstrap_self_managed_addons = false

  vpc_config {
    subnet_ids              = local.private_subnet_ids
    endpoint_private_access = true
    endpoint_public_access  = var.endpoint_public_access
    public_access_cidrs     = var.endpoint_public_access ? var.public_access_cidrs : null
  }

  # Access entries only: no aws-auth ConfigMap to drift. Only the identity that
  # creates the cluster is bootstrapped as admin (a later operator is not);
  # additional_admin_principal_arns adds others, and must not list the creator,
  # whose access entry already exists.
  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = true
  }

  enabled_cluster_log_types = var.cluster_log_types

  upgrade_policy {
    support_type = var.upgrade_support_type
  }

  deletion_protection = var.cluster_deletion_protection

  depends_on = [aws_iam_role_policy_attachment.cluster, aws_cloudwatch_log_group.cluster]
}

resource "aws_eks_access_entry" "admin" {
  for_each      = toset(var.additional_admin_principal_arns)
  cluster_name  = aws_eks_cluster.main.name
  principal_arn = each.value
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "admin" {
  for_each      = toset(var.additional_admin_principal_arns)
  cluster_name  = aws_eks_cluster.main.name
  principal_arn = aws_eks_access_entry.admin[each.key].principal_arn
  policy_arn    = "arn:${local.partition}:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"

  access_scope {
    type = "cluster"
  }
}

locals {
  # Trust policy for every workload role: EKS Pod Identity, from this cluster
  # in this account only. Which service account gets a role is decided by its
  # aws_eks_pod_identity_association.
  pod_identity_trust_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "pods.eks.amazonaws.com" }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
        ArnEquals    = { "aws:SourceArn" = aws_eks_cluster.main.arn }
      }
    }]
  })
}

# Every managed add-on is pinned to the default version for the cluster's
# Kubernetes version, so bumping kubernetes_version moves the add-ons too.
data "aws_eks_addon_version" "pod_identity_agent" {
  addon_name         = "eks-pod-identity-agent"
  kubernetes_version = aws_eks_cluster.main.version
}

data "aws_eks_addon_version" "vpc_cni" {
  addon_name         = "vpc-cni"
  kubernetes_version = aws_eks_cluster.main.version
}

data "aws_eks_addon_version" "kube_proxy" {
  addon_name         = "kube-proxy"
  kubernetes_version = aws_eks_cluster.main.version
}

data "aws_eks_addon_version" "coredns" {
  addon_name         = "coredns"
  kubernetes_version = aws_eks_cluster.main.version
}

resource "aws_eks_addon" "pod_identity_agent" {
  cluster_name  = aws_eks_cluster.main.name
  addon_name    = "eks-pod-identity-agent"
  addon_version = data.aws_eks_addon_version.pod_identity_agent.version
}

# The VPC CNI's own role, so the node role needs no network permissions.
resource "aws_iam_role" "vpc_cni" {
  name               = "${var.name_prefix}-vpc-cni"
  assume_role_policy = local.pod_identity_trust_policy
}

resource "aws_iam_role_policy_attachment" "vpc_cni" {
  role       = aws_iam_role.vpc_cni.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_eks_addon" "vpc_cni" {
  cluster_name  = aws_eks_cluster.main.name
  addon_name    = "vpc-cni"
  addon_version = data.aws_eks_addon_version.vpc_cni.version

  # NetworkPolicy enforcement. Wardby's default-deny policies are the run pods'
  # only egress boundary; without this they are accepted and ignored.
  configuration_values = jsonencode({ enableNetworkPolicy = "true" })

  pod_identity_association {
    role_arn        = aws_iam_role.vpc_cni.arn
    service_account = "aws-node"
  }

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [aws_eks_addon.pod_identity_agent, aws_iam_role_policy_attachment.vpc_cni]
}

resource "aws_eks_addon" "kube_proxy" {
  cluster_name  = aws_eks_cluster.main.name
  addon_name    = "kube-proxy"
  addon_version = data.aws_eks_addon_version.kube_proxy.version
}

# coredns is in nodegroups.tf: its pods need nodes, and the add-on waits for them.
