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


run "database" {
  command = apply

  # Distinct ARNs so an association wired to another workload's role fails the
  # service-account assert below (the header gives every role the same ARN).
  override_resource {
    target = aws_iam_role.database["app"]
    values = { arn = "arn:aws:iam::111122223333:role/wardby-db-app" }
  }
  override_resource {
    target = aws_iam_role.database["migrator"]
    values = { arn = "arn:aws:iam::111122223333:role/wardby-db-migrator" }
  }
  override_resource {
    target = aws_iam_role.database["proxy"]
    values = { arn = "arn:aws:iam::111122223333:role/wardby-db-proxy" }
  }
  override_resource {
    target = aws_iam_role.database["gateway"]
    values = { arn = "arn:aws:iam::111122223333:role/wardby-db-gateway" }
  }

  assert {
    condition     = aws_db_instance.main.engine == "postgres" && aws_db_instance.main.engine_version == "17"
    error_message = "Postgres 17."
  }
  assert {
    condition     = aws_db_instance.main.iam_database_authentication_enabled && aws_db_instance.main.manage_master_user_password
    error_message = "IAM login on; the master password is generated and kept by RDS."
  }
  assert {
    condition     = !aws_db_instance.main.publicly_accessible && aws_db_instance.main.storage_encrypted
    error_message = "Private and encrypted."
  }
  assert {
    condition     = aws_db_instance.main.deletion_protection && aws_db_instance.main.backup_retention_period == 7 && !aws_db_instance.main.skip_final_snapshot
    error_message = "Deletion protection, 7-day backups (PITR) and a final snapshot by default."
  }
  assert {
    condition     = aws_db_instance.main.allow_major_version_upgrade
    error_message = "Changing database_engine_version performs the major upgrade instead of being refused."
  }
  assert {
    condition     = aws_db_parameter_group.main.family == "postgres17" && one([for p in aws_db_parameter_group.main.parameter : p.value if p.name == "rds.force_ssl"]) == "1"
    error_message = "The parameter group forces TLS."
  }
  assert {
    condition     = toset(aws_db_subnet_group.main.subnet_ids) == toset([for s in aws_subnet.database : s.id])
    error_message = "The instance lives in the database tier."
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.database_from_system_nodes.referenced_security_group_id == aws_security_group.system_nodes.id && aws_vpc_security_group_ingress_rule.database_from_system_nodes.from_port == 5432 && aws_vpc_security_group_ingress_rule.database_from_system_nodes.to_port == 5432
    error_message = "Only system nodes may reach 5432."
  }
  assert {
    condition     = toset(aws_db_instance.main.vpc_security_group_ids) == toset([aws_security_group.database.id])
    error_message = "The instance carries only its own security group."
  }
  assert {
    condition     = output.database_users == { app = "wardby-app", migrator = "wardby-migrator", proxy = "wardby-proxy", gateway = "wardby-gateway" }
    error_message = "One Postgres user per workload."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.database_connect["app"].policy).Statement[0].Resource == "arn:aws:rds-db:us-test-1:111122223333:dbuser:db-TESTRESOURCEID/wardby-app"
    error_message = "rds-db:connect is scoped to the instance and the role's own user."
  }
  assert {
    condition = alltrue([
      for k, p in aws_iam_role_policy.database_connect :
      length(jsondecode(p.policy).Statement) == 1
      && jsondecode(p.policy).Statement[0].Action == "rds-db:connect"
      && endswith(jsondecode(p.policy).Statement[0].Resource, "/wardby-${k}")
    ])
    error_message = "No role can connect as another workload's user."
  }
  assert {
    condition = (
      aws_eks_pod_identity_association.database["app"].service_account == "wardby-control-plane"
      && aws_eks_pod_identity_association.database["migrator"].service_account == "wardby-migrator"
      && aws_eks_pod_identity_association.database["proxy"].service_account == "wardby-coding-proxy"
      && aws_eks_pod_identity_association.database["gateway"].service_account == "wardby-native-gateway"
      && alltrue([for k, a in aws_eks_pod_identity_association.database : a.namespace == "wardby-coding" && a.role_arn == aws_iam_role.database[k].arn])
    )
    error_message = "Each workload's service account gets its own role."
  }
  assert {
    condition     = alltrue([for r in aws_iam_role.database : r.assume_role_policy == local.pod_identity_trust_policy])
    error_message = "Database roles trust Pod Identity from this cluster only."
  }
  assert {
    condition     = output.database_master_user_secret_arn == "arn:aws:secretsmanager:us-test-1:111122223333:secret:rds!db-test"
    error_message = "The bootstrap needs the master secret's ARN."
  }
}

run "apply_immediately_defaults_off" {
  command = apply

  assert {
    condition     = !aws_db_instance.main.apply_immediately
    error_message = "Database changes wait for the maintenance window by default."
  }
}

run "multi_az_and_no_deletion_protection" {
  command = apply
  variables {
    database_multi_az            = true
    database_deletion_protection = false
  }

  assert {
    condition     = aws_db_instance.main.multi_az && !aws_db_instance.main.deletion_protection
    error_message = "Variables reach the instance."
  }
}

run "major_version_change" {
  command = apply
  variables {
    database_engine_version    = "18"
    database_apply_immediately = true
  }

  assert {
    condition     = aws_db_instance.main.apply_immediately
    error_message = "database_apply_immediately reaches the instance."
  }

  assert {
    condition     = aws_db_parameter_group.main.family == "postgres18" && endswith(aws_db_parameter_group.main.name, "postgres18") && aws_db_instance.main.engine_version == "18"
    error_message = "The engine version reaches the instance and a version-named parameter group."
  }
}
