output "region" {
  value = var.region
}

output "account_id" {
  description = "Account the module was applied in."
  value       = local.account_id
}
