# Account-wide facts the other files build ARNs and endpoints from. Nothing here
# is hardcoded: the account and partition come from the credentials Terraform
# runs with.

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  dns_suffix = data.aws_partition.current.dns_suffix
}
