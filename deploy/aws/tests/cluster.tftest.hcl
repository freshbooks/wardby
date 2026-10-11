# Mock providers: no AWS account, no credentials, nothing is created.
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111122223333", arn = "arn:aws:iam::111122223333:role/terraform-test" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-test-1a", "us-test-1b", "us-test-1c", "us-test-1d"] }
  }
  mock_data "aws_subnet" {
    defaults = { cidr_block = "10.99.0.0/24" }
  }
  mock_data "aws_eks_addon_version" {
    defaults = { version = "v1.0.0-eksbuild.1" }
  }
  mock_resource "aws_db_instance" {
    defaults = {
      resource_id        = "db-TESTRESOURCEID"
      master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:us-test-1:111122223333:secret:rds!db-test", kms_key_id = "", secret_status = "active" }]
    }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111122223333:role/mock-role" }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::111122223333:policy/mock-policy" }
  }
  mock_resource "aws_eks_cluster" {
    defaults = { arn = "arn:aws:eks:us-test-1:111122223333:cluster/wardby" }
  }
  mock_resource "aws_launch_template" {
    defaults = { id = "lt-0123456789abcdef0" }
  }
  mock_resource "aws_acm_certificate" {
    defaults = {
      domain_validation_options = [{
        domain_name           = "wardby.example.com"
        resource_record_name  = "_abc.wardby.example.com."
        resource_record_type  = "CNAME"
        resource_record_value = "_def.acm-validations.aws."
      }]
    }
  }
}

mock_provider "http" {
  mock_data "http" {
    defaults = { status_code = 200, response_body = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

variables {
  region                = "us-test-1"
  hostname              = "wardby.example.com"
  public_access_cidrs   = ["203.0.113.10/32"]
  lbc_iam_policy_sha256 = "8f907b489532ad56fb7c52f3acc89b27680ed51296bf03984ce78d2b7b96076a" # sha256 of the mock body above
}

run "cluster" {
  command = apply

  override_resource {
    target = aws_iam_role.vpc_cni
    values = { arn = "arn:aws:iam::111122223333:role/wardby-vpc-cni" }
  }

  # Distinct versions so an add-on wired to another add-on's lookup fails.
  override_data {
    target = data.aws_eks_addon_version.vpc_cni
    values = { version = "v1.20.0-eksbuild.1" }
  }
  override_data {
    target = data.aws_eks_addon_version.kube_proxy
    values = { version = "v1.36.0-eksbuild.2" }
  }
  override_data {
    target = data.aws_eks_addon_version.pod_identity_agent
    values = { version = "v1.3.9-eksbuild.3" }
  }
  override_data {
    target = data.aws_eks_addon_version.coredns
    values = { version = "v1.12.4-eksbuild.4" }
  }

  assert {
    condition     = aws_eks_addon.vpc_cni.addon_version == "v1.20.0-eksbuild.1" && aws_eks_addon.kube_proxy.addon_version == "v1.36.0-eksbuild.2" && aws_eks_addon.pod_identity_agent.addon_version == "v1.3.9-eksbuild.3" && aws_eks_addon.coredns.addon_version == "v1.12.4-eksbuild.4"
    error_message = "Each managed add-on is pinned to the version its own aws_eks_addon_version lookup returns."
  }
  assert {
    condition = alltrue([for d in [
      [data.aws_eks_addon_version.vpc_cni, "vpc-cni"],
      [data.aws_eks_addon_version.kube_proxy, "kube-proxy"],
      [data.aws_eks_addon_version.pod_identity_agent, "eks-pod-identity-agent"],
      [data.aws_eks_addon_version.coredns, "coredns"],
    ] : d[0].addon_name == d[1] && d[0].kubernetes_version == aws_eks_cluster.main.version && d[0].most_recent != true])
    error_message = "Add-on versions are the default for the cluster's Kubernetes version, looked up per add-on."
  }
  assert {
    condition     = aws_eks_cluster.main.bootstrap_self_managed_addons == false
    error_message = "EKS must install no self-managed add-ons: the module's managed add-ons are the only ones."
  }
  assert {
    condition     = aws_cloudwatch_log_group.cluster.name == "/aws/eks/wardby/cluster" && aws_cloudwatch_log_group.cluster.retention_in_days == 90
    error_message = "The module owns the control-plane log group (the name EKS writes to), with 90 days' retention by default."
  }

  assert {
    condition     = aws_eks_cluster.main.name == "wardby" && aws_eks_cluster.main.version == "1.36"
    error_message = "Cluster name is name_prefix; version is kubernetes_version."
  }
  assert {
    condition     = aws_eks_cluster.main.access_config[0].authentication_mode == "API" && aws_eks_cluster.main.access_config[0].bootstrap_cluster_creator_admin_permissions
    error_message = "Access entries only (no aws-auth ConfigMap); the applier is bootstrapped as admin."
  }
  assert {
    condition     = aws_eks_cluster.main.vpc_config[0].endpoint_private_access && aws_eks_cluster.main.vpc_config[0].endpoint_public_access && toset(aws_eks_cluster.main.vpc_config[0].public_access_cidrs) == toset(["203.0.113.10/32"])
    error_message = "Private endpoint on; public endpoint limited to public_access_cidrs."
  }
  assert {
    condition     = toset(aws_eks_cluster.main.vpc_config[0].subnet_ids) == toset(output.private_subnet_ids)
    error_message = "The cluster's ENIs go in the private subnets."
  }
  assert {
    condition     = aws_eks_cluster.main.deletion_protection && aws_eks_cluster.main.upgrade_policy[0].support_type == "STANDARD"
    error_message = "Deletion protection and STANDARD upgrade policy by default."
  }
  assert {
    condition     = jsondecode(aws_eks_addon.vpc_cni.configuration_values).enableNetworkPolicy == "true"
    error_message = "The VPC CNI must enforce NetworkPolicy."
  }
  assert {
    condition     = one([for a in aws_eks_addon.vpc_cni.pod_identity_association : a.service_account]) == "aws-node" && one([for a in aws_eks_addon.vpc_cni.pod_identity_association : a.role_arn]) == aws_iam_role.vpc_cni.arn
    error_message = "The VPC CNI gets its own Pod Identity role, keeping the node role minimal."
  }
  assert {
    condition     = jsondecode(local.pod_identity_trust_policy).Statement[0].Principal.Service == "pods.eks.amazonaws.com" && jsondecode(local.pod_identity_trust_policy).Statement[0].Condition.ArnEquals["aws:SourceArn"] == aws_eks_cluster.main.arn && jsondecode(local.pod_identity_trust_policy).Statement[0].Condition.StringEquals["aws:SourceAccount"] == "111122223333"
    error_message = "Pod Identity roles trust only this cluster in this account."
  }
  assert {
    condition     = toset(jsondecode(local.pod_identity_trust_policy).Statement[0].Action) == toset(["sts:AssumeRole", "sts:TagSession"])
    error_message = "Pod Identity needs AssumeRole and TagSession."
  }
  assert {
    condition     = aws_iam_role_policy_attachment.cluster.policy_arn == "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
    error_message = "Cluster role gets AmazonEKSClusterPolicy."
  }
  assert {
    condition     = length(aws_eks_access_entry.admin) == 0
    error_message = "No extra admins by default."
  }
  assert {
    condition     = output.kubeconfig_command == "aws eks update-kubeconfig --region us-test-1 --name wardby"
    error_message = "Unexpected kubeconfig command."
  }
}

run "extra_admins_get_cluster_admin" {
  command = apply
  variables { additional_admin_principal_arns = ["arn:aws:iam::111122223333:role/ops"] }

  assert {
    condition     = aws_eks_access_policy_association.admin["arn:aws:iam::111122223333:role/ops"].policy_arn == "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy" && aws_eks_access_policy_association.admin["arn:aws:iam::111122223333:role/ops"].access_scope[0].type == "cluster"
    error_message = "Extra admins get cluster-scoped AmazonEKSClusterAdminPolicy."
  }
}

run "log_retention_follows_variable" {
  command = apply
  variables {
    name_prefix                = "wardby-staging"
    cluster_log_retention_days = 30
  }

  assert {
    condition     = aws_cloudwatch_log_group.cluster.name == "/aws/eks/wardby-staging/cluster" && aws_cloudwatch_log_group.cluster.retention_in_days == 30
    error_message = "The log group follows name_prefix and cluster_log_retention_days."
  }
}

run "private_only_endpoint" {
  command = apply
  variables {
    endpoint_public_access = false
    public_access_cidrs    = []
  }

  assert {
    condition     = !aws_eks_cluster.main.vpc_config[0].endpoint_public_access
    error_message = "endpoint_public_access=false must close the public endpoint."
  }
}
