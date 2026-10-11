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


run "edge_without_route53" {
  command = apply

  # Distinct ARN so an association wired to another role fails the role_arn
  # assert below (the header gives every role the same ARN).
  override_resource {
    target = aws_iam_role.lbc
    values = { arn = "arn:aws:iam::111122223333:role/wardby-lbc" }
  }

  assert {
    condition     = aws_acm_certificate.control_plane.domain_name == "wardby.example.com" && aws_acm_certificate.control_plane.validation_method == "DNS"
    error_message = "DNS-validated certificate for hostname."
  }
  assert {
    condition     = length(aws_route53_record.certificate_validation) == 0 && length(aws_acm_certificate_validation.control_plane) == 0
    error_message = "Without a zone, no records are created and apply does not wait."
  }
  assert {
    condition     = output.certificate_validation_records == [{ name = "_abc.wardby.example.com.", type = "CNAME", value = "_def.acm-validations.aws." }]
    error_message = "Without a zone, the validation records are output for the operator."
  }
  assert {
    condition     = aws_wafv2_web_acl.control_plane.scope == "REGIONAL" && length(aws_wafv2_web_acl.control_plane.default_action[0].allow) == 1
    error_message = "Regional ACL (ALB), default allow."
  }
  assert {
    condition = (
      one([for r in aws_wafv2_web_acl.control_plane.rule : r.statement[0].rate_based_statement[0].limit if r.name == "rate-limit-per-ip"]) == 300
      && one([for r in aws_wafv2_web_acl.control_plane.rule : r.statement[0].rate_based_statement[0].evaluation_window_sec if r.name == "rate-limit-per-ip"]) == 60
      && one([for r in aws_wafv2_web_acl.control_plane.rule : r.action[0].block[0].custom_response[0].response_code if r.name == "rate-limit-per-ip"]) == 429
    )
    error_message = "Per-IP rate limit 300/60 s, answered with 429."
  }
  assert {
    condition     = one([for r in aws_wafv2_web_acl.control_plane.rule : length(r.override_action[0].none) if r.name == "aws-ip-reputation"]) == 1
    error_message = "The IP reputation list blocks."
  }
  assert {
    condition     = alltrue([for r in aws_wafv2_web_acl.control_plane.rule : length(r.override_action[0].count) == 1 if contains(["aws-common", "aws-known-bad-inputs"], r.name)])
    error_message = "Body-inspecting managed groups only count by default."
  }
  assert {
    condition     = aws_iam_policy.lbc.policy == "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    error_message = "The LBC policy is the downloaded document, unmodified."
  }
  assert {
    condition     = aws_eks_pod_identity_association.lbc.namespace == "kube-system" && aws_eks_pod_identity_association.lbc.service_account == "aws-load-balancer-controller" && aws_eks_pod_identity_association.lbc.role_arn == aws_iam_role.lbc.arn
    error_message = "The controller's service account gets the role."
  }
}

run "edge_with_route53" {
  command = apply
  variables { route53_zone_id = "Z0TESTZONE" }

  assert {
    condition     = length(aws_route53_record.certificate_validation) == 1 && aws_route53_record.certificate_validation["wardby.example.com"].name == "_abc.wardby.example.com." && length(aws_acm_certificate_validation.control_plane) == 1
    error_message = "With a zone, the module creates the validation record and waits for issuance."
  }
}

run "managed_rules_can_block" {
  command = apply
  variables { waf_managed_rules_action = "block" }

  assert {
    condition     = alltrue([for r in aws_wafv2_web_acl.control_plane.rule : length(r.override_action[0].none) == 1 if contains(["aws-common", "aws-known-bad-inputs"], r.name)])
    error_message = "waf_managed_rules_action=block lets the groups block."
  }
}

run "tampered_lbc_policy_is_refused" {
  command = plan
  variables { lbc_iam_policy_sha256 = "0000000000000000000000000000000000000000000000000000000000000000" }
  expect_failures = [data.http.lbc_iam_policy]
}
