# Two managed node groups:
#
#   system  -- untainted; the control plane, coding proxy, native gateway, ESO,
#              the load balancer controller, coredns.
#   sandbox -- tainted sandbox=gvisor:NoSchedule and labelled
#              wardby.dev/sandbox=gvisor; gVisor is installed at boot by
#              gvisor-install.sh, which gates kubelet on a marker file it
#              writes only after a verified install: kubelet will not start
#              (and the node never joins) until the marker exists. Only pods
#              using the gvisor RuntimeClass (coding runs, native workers) land
#              here: the RuntimeClass adds the matching nodeSelector and
#              toleration.
#
# Both use a launch template on the EKS-optimized AL2023 AMI (ami_type, no
# image_id, so EKS supplies the cluster's NodeConfig and merges ours), with
# IMDSv2 required and a hop limit of 1 so pods cannot reach instance metadata.

locals {
  # Must equal EKS_SANDBOX_NODE_LABEL, EKS_SANDBOX_TAINT_KEY and
  # GVISOR_RUNTIME_CLASS in src/providers/jobs/kubernetes-platform.ts;
  # module.test.mjs checks.
  sandbox_label_key = "wardby.dev/sandbox"
  sandbox_taint_key = "sandbox"
  sandbox_value     = "gvisor"

  gvisor_install_script = join("\n", [
    "#!/usr/bin/env bash",
    "export GVISOR_VERSION='${var.gvisor_version}'",
    "export GVISOR_SHA512='${var.gvisor_sha512}'",
    "export GVISOR_BASE_URL='${var.gvisor_download_base_url}'",
    file("${path.module}/gvisor-install.sh"),
  ])

  # Registers runsc with containerd. Schema version 2 on purpose: nodeadm
  # accepts a version 2 snippet on containerd 1.x and 2.x (migrating it on 2.x),
  # while a version 3 snippet is refused on 1.x.
  sandbox_nodeconfig = <<-EOT
    apiVersion: node.eks.aws/v1alpha1
    kind: NodeConfig
    spec:
      containerd:
        config: |
          version = 2
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]
            runtime_type = "io.containerd.runsc.v1"
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc.options]
            TypeUrl = "io.containerd.runsc.v1.options"
            ConfigPath = "/etc/containerd/runsc.toml"
  EOT
}

resource "aws_iam_role" "node" {
  name = "${var.name_prefix}-eks-node"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Minimal: join the cluster and pull images. The VPC CNI has its own role
# (cluster.tf); workloads get theirs through Pod Identity.
resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset([
    "arn:${local.partition}:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:${local.partition}:iam::aws:policy/AmazonEC2ContainerRegistryPullOnly",
  ])
  role       = aws_iam_role.node.name
  policy_arn = each.value
}

# Carried only by system nodes. It has no rules of its own (the cluster security
# group already allows node traffic and egress); it exists so the database can
# admit system nodes and nothing else -- run pods on sandbox nodes have no
# network path to Postgres even before NetworkPolicy.
resource "aws_security_group" "system_nodes" {
  name        = "${var.name_prefix}-system-nodes"
  description = "System nodes: the only source the database admits"
  vpc_id      = local.vpc_id
}

data "cloudinit_config" "sandbox" {
  gzip          = false
  base64_encode = true

  part {
    content_type = "application/node.eks.aws"
    content      = local.sandbox_nodeconfig
  }

  part {
    content_type = "text/x-shellscript"
    content      = local.gvisor_install_script
  }
}

resource "aws_launch_template" "system" {
  name_prefix            = "${var.name_prefix}-system-"
  update_default_version = true
  vpc_security_group_ids = [aws_eks_cluster.main.vpc_config[0].cluster_security_group_id, aws_security_group.system_nodes.id]

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = var.system_disk_size_gb
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${var.name_prefix}-system" }
  }
}

resource "aws_launch_template" "sandbox" {
  name_prefix            = "${var.name_prefix}-sandbox-"
  update_default_version = true
  user_data              = data.cloudinit_config.sandbox.rendered
  vpc_security_group_ids = [aws_eks_cluster.main.vpc_config[0].cluster_security_group_id]

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = var.sandbox_disk_size_gb
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${var.name_prefix}-sandbox" }
  }
}

resource "aws_eks_node_group" "system" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${var.name_prefix}-system"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = local.private_subnet_ids
  ami_type        = "AL2023_x86_64_STANDARD"
  release_version = var.node_ami_release_version
  instance_types  = var.system_instance_types
  capacity_type   = "ON_DEMAND"

  scaling_config {
    min_size     = var.system_min_size
    desired_size = var.system_desired_size
    max_size     = var.system_max_size
  }

  launch_template {
    id      = aws_launch_template.system.id
    version = aws_launch_template.system.latest_version
  }

  update_config {
    max_unavailable = 1
  }

  labels = { "wardby.dev/pool" = "system" }

  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]
  }

  depends_on = [aws_iam_role_policy_attachment.node, aws_eks_addon.vpc_cni]
}

resource "aws_eks_node_group" "sandbox" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${var.name_prefix}-sandbox"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = local.private_subnet_ids
  ami_type        = "AL2023_x86_64_STANDARD"
  release_version = var.node_ami_release_version
  instance_types  = var.sandbox_instance_types
  capacity_type   = "ON_DEMAND"

  scaling_config {
    min_size     = var.sandbox_min_size
    desired_size = var.sandbox_desired_size
    max_size     = var.sandbox_max_size
  }

  launch_template {
    id      = aws_launch_template.sandbox.id
    version = aws_launch_template.sandbox.latest_version
  }

  update_config {
    max_unavailable = 1
  }

  labels = { (local.sandbox_label_key) = local.sandbox_value }

  taint {
    key    = local.sandbox_taint_key
    value  = local.sandbox_value
    effect = "NO_SCHEDULE"
  }

  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]
  }

  depends_on = [aws_iam_role_policy_attachment.node, aws_eks_addon.vpc_cni]
}

resource "aws_eks_addon" "coredns" {
  cluster_name = aws_eks_cluster.main.name
  addon_name   = "coredns"

  depends_on = [aws_eks_node_group.system]
}
