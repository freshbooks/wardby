output "region" {
  value = var.region
}

output "account_id" {
  description = "Account the module was applied in."
  value       = local.account_id
}

output "vpc_id" {
  description = "The VPC (created, or existing_vpc_id). The load balancer controller needs it passed explicitly: IMDS is closed to pods."
  value       = local.vpc_id
}

output "public_subnet_ids" {
  description = "Subnets for the internet-facing load balancer."
  value       = local.public_subnet_ids
}

output "private_subnet_ids" {
  description = "Subnets of the EKS nodes and pods."
  value       = local.private_subnet_ids
}

output "database_subnet_cidrs" {
  description = "CIDRs of the database subnets, for the workloads' database egress NetworkPolicies."
  value       = local.database_subnet_cidrs
}

output "cluster_name" {
  value = aws_eks_cluster.main.name
}

output "cluster_arn" {
  value = aws_eks_cluster.main.arn
}

output "cluster_endpoint" {
  description = "Kubernetes API endpoint."
  value       = aws_eks_cluster.main.endpoint
}

output "cluster_security_group_id" {
  description = "The EKS-managed cluster security group (on every node)."
  value       = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
}

output "kubeconfig_command" {
  description = "Creates the kubectl context for this cluster."
  value       = "aws eks update-kubeconfig --region ${var.region} --name ${aws_eks_cluster.main.name}"
}

output "sandbox_node_selector" {
  description = "nodeSelector the gvisor RuntimeClass's scheduling block must add."
  value       = { (local.sandbox_label_key) = local.sandbox_value }
}

output "sandbox_toleration" {
  description = "Taint on sandbox nodes (key=value:effect) the gvisor RuntimeClass must tolerate."
  value       = "${local.sandbox_taint_key}=${local.sandbox_value}:NoSchedule"
}

output "database_endpoint" {
  description = "RDS host name (TLS server name for sslmode=verify-full)."
  value       = aws_db_instance.main.address
}

output "database_port" {
  value = aws_db_instance.main.port
}

output "database_name" {
  value = aws_db_instance.main.db_name
}

output "database_resource_id" {
  description = "The instance's resource id (the dbuser ARNs' instance part)."
  value       = aws_db_instance.main.resource_id
}

output "database_master_username" {
  value = aws_db_instance.main.username
}

output "database_master_user_secret_arn" {
  description = "Secrets Manager secret holding the RDS-managed master password, for the one-off grants bootstrap."
  value       = try(aws_db_instance.main.master_user_secret[0].secret_arn, null)
}

output "database_users" {
  description = "Postgres user per workload; the grants bootstrap creates them with GRANT rds_iam."
  value       = local.database_users
}

output "database_role_arns" {
  value = { for k, r in aws_iam_role.database : k => r.arn }
}
