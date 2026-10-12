# The run dependency cache: nothing by default; when on, a private bucket and a
# policy on the proxy's role only. Mock providers: nothing is created.
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
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::example-dependency-cache" }
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

run "off_by_default_creates_nothing" {
  command = apply

  assert {
    condition     = length(aws_s3_bucket.dependency_cache) == 0 && length(aws_iam_role_policy.dependency_cache_proxy) == 0
    error_message = "No bucket and no policy unless dependency_cache_enabled."
  }
  assert {
    condition     = output.dependency_cache_bucket == ""
    error_message = "The bucket output is empty when off."
  }
}

run "on_creates_a_private_bucket_scoped_to_the_proxy_role" {
  command = apply

  variables {
    dependency_cache_enabled      = true
    dependency_cache_bucket_name  = "example-dependency-cache"
    dependency_cache_max_age_days = 10
  }

  assert {
    condition     = output.dependency_cache_bucket == "example-dependency-cache"
    error_message = "The bucket output names the bucket."
  }
  assert {
    condition = (
      aws_s3_bucket_public_access_block.dependency_cache[0].block_public_acls &&
      aws_s3_bucket_public_access_block.dependency_cache[0].block_public_policy &&
      aws_s3_bucket_public_access_block.dependency_cache[0].ignore_public_acls &&
      aws_s3_bucket_public_access_block.dependency_cache[0].restrict_public_buckets
    )
    error_message = "All four public access blocks are on."
  }
  assert {
    condition = (
      [for r in aws_s3_bucket_lifecycle_configuration.dependency_cache[0].rule : r.expiration[0].days if r.id == "expire-orphaned-snapshots"][0] == 17 &&
      [for r in aws_s3_bucket_lifecycle_configuration.dependency_cache[0].rule : r.abort_incomplete_multipart_upload[0].days_after_initiation if r.id == "abort-incomplete-multipart-uploads"][0] == 1
    )
    error_message = "Orphans expire max_age_days + 7 days after creation; incomplete multipart uploads abort after one day."
  }
  assert {
    condition     = aws_iam_role_policy.dependency_cache_proxy[0].role == aws_iam_role.database["proxy"].id
    error_message = "The bucket policy is attached to the proxy role only."
  }
}
