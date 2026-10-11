# The public edge's AWS-side pieces. The load balancer itself is created later
# by the AWS Load Balancer Controller from the Gateway in the Kubernetes
# manifests; those reference the certificate and web ACL by the ARNs output
# here. The hostname's DNS record points at that load balancer, so it is not
# created here.

resource "aws_acm_certificate" "control_plane" {
  domain_name       = var.hostname
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

locals {
  certificate_validation = { for o in aws_acm_certificate.control_plane.domain_validation_options : o.domain_name => o }
}

# Keyed by the hostname (known at plan time), not by the computed options.
resource "aws_route53_record" "certificate_validation" {
  for_each = var.route53_zone_id == null ? toset([]) : toset([var.hostname])

  zone_id         = var.route53_zone_id
  name            = local.certificate_validation[each.key].resource_record_name
  type            = local.certificate_validation[each.key].resource_record_type
  records         = [local.certificate_validation[each.key].resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "control_plane" {
  count = var.route53_zone_id == null ? 0 : 1

  certificate_arn         = aws_acm_certificate.control_plane.arn
  validation_record_fqdns = [for r in aws_route53_record.certificate_validation : r.fqdn]
}

locals {
  # Body-inspecting groups: their rules match code in MCP tool arguments and
  # large webhook payloads, so they count by default (waf_managed_rules_action).
  inspecting_rule_groups = {
    "aws-common"           = { priority = 2, name = "AWSManagedRulesCommonRuleSet" }
    "aws-known-bad-inputs" = { priority = 3, name = "AWSManagedRulesKnownBadInputsRuleSet" }
  }
}

resource "aws_wafv2_web_acl" "control_plane" {
  name  = "${var.name_prefix}-control-plane"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  custom_response_body {
    key          = "rate-limited"
    content      = "Too many requests"
    content_type = "TEXT_PLAIN"
  }

  # The application has its own per-IP limiter; a caller spread across many
  # addresses walks past it. Generous on purpose: MCP is a chatty protocol.
  rule {
    name     = "rate-limit-per-ip"
    priority = 0

    action {
      block {
        custom_response {
          response_code            = 429
          custom_response_body_key = "rate-limited"
        }
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_rate_limit
        evaluation_window_sec = var.waf_rate_limit_window_seconds
        aggregate_key_type    = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-ip-reputation"
    priority = 1

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesAmazonIpReputationList"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-ip-reputation"
      sampled_requests_enabled   = true
    }
  }

  dynamic "rule" {
    for_each = local.inspecting_rule_groups
    content {
      name     = rule.key
      priority = rule.value.priority

      override_action {
        dynamic "count" {
          for_each = var.waf_managed_rules_action == "count" ? [1] : []
          content {}
        }
        dynamic "none" {
          for_each = var.waf_managed_rules_action == "block" ? [1] : []
          content {}
        }
      }

      statement {
        managed_rule_group_statement {
          vendor_name = "AWS"
          name        = rule.value.name
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.name_prefix}-${rule.key}"
        sampled_requests_enabled   = true
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name_prefix}-control-plane"
    sampled_requests_enabled   = true
  }
}
