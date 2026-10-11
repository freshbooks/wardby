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
  mock_resource "aws_db_instance" {
    defaults = {
      resource_id        = "db-TESTRESOURCEID"
      master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:us-test-1:111122223333:secret:rds!db-test", kms_key_id = "", secret_status = "active" }]
    }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111122223333:role/mock-role" }
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

run "node_groups" {
  command = apply

  # Distinct ids so a swapped launch template (system nodes carry the
  # database's only admitted security group) fails the wiring asserts below.
  override_resource {
    target = aws_launch_template.system
    values = { id = "lt-0aaaaaaaaaaaaaaa1", latest_version = 3 }
  }
  override_resource {
    target = aws_launch_template.sandbox
    values = { id = "lt-0bbbbbbbbbbbbbbb2", latest_version = 7 }
  }

  assert {
    condition     = aws_eks_node_group.system.launch_template[0].id == aws_launch_template.system.id && aws_eks_node_group.system.launch_template[0].version == tostring(aws_launch_template.system.latest_version)
    error_message = "The system node group uses the system launch template, at its latest version."
  }
  assert {
    condition     = aws_eks_node_group.sandbox.launch_template[0].id == aws_launch_template.sandbox.id && aws_eks_node_group.sandbox.launch_template[0].version == tostring(aws_launch_template.sandbox.latest_version)
    error_message = "The sandbox node group uses the sandbox launch template, at its latest version."
  }

  assert {
    condition     = aws_eks_node_group.sandbox.labels["wardby.dev/sandbox"] == "gvisor"
    error_message = "Sandbox nodes carry wardby.dev/sandbox=gvisor (the gvisor RuntimeClass's nodeSelector)."
  }
  assert {
    condition     = length(aws_eks_node_group.sandbox.taint) == 1 && one(aws_eks_node_group.sandbox.taint).key == "sandbox" && one(aws_eks_node_group.sandbox.taint).value == "gvisor" && one(aws_eks_node_group.sandbox.taint).effect == "NO_SCHEDULE"
    error_message = "Sandbox nodes are tainted sandbox=gvisor:NoSchedule."
  }
  assert {
    condition     = length(aws_eks_node_group.system.taint) == 0
    error_message = "System nodes are untainted."
  }
  assert {
    condition     = aws_eks_node_group.sandbox.ami_type == "AL2023_x86_64_STANDARD" && aws_eks_node_group.system.ami_type == "AL2023_x86_64_STANDARD"
    error_message = "Both groups run the EKS-optimized AL2023 AMI."
  }
  assert {
    condition     = aws_eks_node_group.sandbox.scaling_config[0].min_size == 0 && aws_eks_node_group.sandbox.scaling_config[0].desired_size == 1
    error_message = "Sandbox group defaults: min 0, desired 1."
  }
  assert {
    condition     = alltrue([for lt in [aws_launch_template.system, aws_launch_template.sandbox] : lt.metadata_options[0].http_tokens == "required" && lt.metadata_options[0].http_put_response_hop_limit == 1])
    error_message = "IMDSv2 only, hop limit 1: pods cannot reach the node's instance metadata."
  }
  assert {
    condition     = alltrue([for lt in [aws_launch_template.system, aws_launch_template.sandbox] : lt.block_device_mappings[0].ebs[0].encrypted == "true" && lt.block_device_mappings[0].ebs[0].volume_type == "gp3"])
    error_message = "Root volumes are encrypted gp3."
  }
  assert {
    condition     = contains(tolist(aws_launch_template.system.vpc_security_group_ids), aws_security_group.system_nodes.id) && !contains(tolist(aws_launch_template.sandbox.vpc_security_group_ids), aws_security_group.system_nodes.id)
    error_message = "Only system nodes carry the system_nodes group (the database's only admitted source)."
  }
  assert {
    condition     = toset(aws_launch_template.sandbox.vpc_security_group_ids) == toset([aws_eks_cluster.main.vpc_config[0].cluster_security_group_id])
    error_message = "Sandbox nodes carry only the cluster security group."
  }
  assert {
    condition     = strcontains(base64decode(aws_launch_template.sandbox.user_data), "export GVISOR_SHA512='${var.gvisor_sha512}'") && strcontains(base64decode(aws_launch_template.sandbox.user_data), "export GVISOR_VERSION='20260921.0'")
    error_message = "Sandbox user data pins the gVisor version and checksum."
  }
  assert {
    condition     = strcontains(base64decode(aws_launch_template.sandbox.user_data), "application/node.eks.aws") && strcontains(base64decode(aws_launch_template.sandbox.user_data), "runtime_type = \"io.containerd.runsc.v1\"")
    error_message = "Sandbox user data registers the runsc runtime with containerd through nodeadm."
  }
  assert {
    condition     = aws_launch_template.system.user_data == null
    error_message = "System nodes need no user data."
  }
  assert {
    condition     = toset([for a in aws_iam_role_policy_attachment.node : a.policy_arn]) == toset(["arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy", "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPullOnly"])
    error_message = "The node role is minimal: worker node + ECR pull."
  }
  assert {
    condition     = tomap(output.sandbox_node_selector) == tomap({ "wardby.dev/sandbox" = "gvisor" }) && output.sandbox_toleration == "sandbox=gvisor:NoSchedule"
    error_message = "Outputs describe the RuntimeClass scheduling."
  }
}
