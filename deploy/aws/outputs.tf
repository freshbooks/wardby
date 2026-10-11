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
