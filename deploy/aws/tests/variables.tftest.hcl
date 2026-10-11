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

run "defaults_plan" {
  command = plan
}

run "partial_byo_vpc_is_refused" {
  command = plan
  variables { existing_vpc_id = "vpc-0abc" }
  expect_failures = [var.existing_vpc_id]
}

run "byo_vpc_with_one_zone_is_refused" {
  command = plan
  variables {
    existing_vpc_id              = "vpc-0abc"
    existing_public_subnet_ids   = ["subnet-p1"]
    existing_private_subnet_ids  = ["subnet-a1", "subnet-a2"]
    existing_database_subnet_ids = ["subnet-d1", "subnet-d2"]
  }
  expect_failures = [var.existing_vpc_id]
}

run "open_public_endpoint_is_refused" {
  command = plan
  variables { public_access_cidrs = ["0.0.0.0/0"] }
  expect_failures = [var.public_access_cidrs]
}

run "public_endpoint_without_cidrs_is_refused" {
  command = plan
  variables { public_access_cidrs = [] }
  expect_failures = [var.public_access_cidrs]
}

run "private_only_endpoint_needs_no_cidrs" {
  command = plan
  variables {
    endpoint_public_access = false
    public_access_cidrs    = []
  }
}

run "malformed_gvisor_checksum_is_refused" {
  command = plan
  variables { gvisor_sha512 = "abc" }
  expect_failures = [var.gvisor_sha512]
}

run "non_https_gvisor_mirror_is_refused" {
  command = plan
  variables { gvisor_download_base_url = "http://mirror.example.com/gvisor" }
  expect_failures = [var.gvisor_download_base_url]
}

run "bad_hostname_is_refused" {
  command = plan
  variables { hostname = "localhost" }
  expect_failures = [var.hostname]
}

run "sandbox_desired_below_min_is_refused" {
  command = plan
  variables {
    sandbox_min_size     = 2
    sandbox_desired_size = 1
  }
  expect_failures = [var.sandbox_desired_size]
}

run "bad_name_prefix_is_refused" {
  command = plan
  variables { name_prefix = "Wardby_Prod" }
  expect_failures = [var.name_prefix]
}

run "bad_waf_window_is_refused" {
  command = plan
  variables { waf_rate_limit_window_seconds = 90 }
  expect_failures = [var.waf_rate_limit_window_seconds]
}

run "vpc_cidr_outside_supported_sizes_is_refused" {
  command = plan
  variables { vpc_cidr = "10.0.0.0/24" }
  expect_failures = [var.vpc_cidr]
}
