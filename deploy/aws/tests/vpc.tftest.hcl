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

run "creates_three_tiers_across_three_zones" {
  command = apply

  assert {
    condition     = length(aws_subnet.public) == 3 && length(aws_subnet.private) == 3 && length(aws_subnet.database) == 3
    error_message = "Expected three subnets per tier."
  }
  assert {
    condition     = toset([for s in aws_subnet.private : s.availability_zone]) == toset(["us-test-1a", "us-test-1b", "us-test-1c"])
    error_message = "Private subnets must span the first three zones."
  }
  assert {
    condition     = aws_subnet.private["us-test-1a"].cidr_block == "10.40.0.0/18" && aws_subnet.public["us-test-1a"].cidr_block == "10.40.192.0/22" && aws_subnet.database["us-test-1a"].cidr_block == "10.40.208.0/22"
    error_message = "Unexpected subnet layout."
  }
  assert {
    condition     = aws_vpc.main[0].enable_dns_support && aws_vpc.main[0].enable_dns_hostnames
    error_message = "EKS private endpoint access needs DNS support and hostnames."
  }
  assert {
    condition     = alltrue([for s in aws_subnet.public : s.tags["kubernetes.io/role/elb"] == "1" && !s.map_public_ip_on_launch])
    error_message = "Public subnets are for load balancers and must not hand out public IPs."
  }
  assert {
    condition     = alltrue([for s in aws_subnet.private : s.tags["kubernetes.io/role/internal-elb"] == "1"])
    error_message = "Private subnets need the internal-elb role tag."
  }
  assert {
    condition     = length(aws_nat_gateway.main) == 1
    error_message = "single_nat_gateway defaults to one NAT gateway."
  }
  assert {
    condition     = alltrue([for r in aws_route.private_nat : r.route_table_id != aws_route_table.database[0].id]) && aws_route.public_internet[0].route_table_id != aws_route_table.database[0].id
    error_message = "The database tier must have no route out of the VPC."
  }
  assert {
    condition     = output.vpc_id == aws_vpc.main[0].id && output.database_subnet_cidrs == tolist(["10.40.208.0/22", "10.40.212.0/22", "10.40.216.0/22"])
    error_message = "Outputs must describe the created VPC."
  }
}

run "one_nat_per_zone_when_not_single" {
  command = apply
  variables { single_nat_gateway = false }

  assert {
    condition     = length(aws_nat_gateway.main) == 3 && length(aws_route.private_nat) == 3
    error_message = "Expected a NAT gateway and default route per zone."
  }
}

run "bring_your_own_vpc_creates_no_network" {
  command = apply
  variables {
    existing_vpc_id              = "vpc-0byo"
    existing_public_subnet_ids   = ["subnet-p1", "subnet-p2"]
    existing_private_subnet_ids  = ["subnet-a1", "subnet-a2"]
    existing_database_subnet_ids = ["subnet-d1", "subnet-d2"]
  }

  assert {
    condition     = length(aws_vpc.main) == 0 && length(aws_subnet.private) == 0 && length(aws_nat_gateway.main) == 0 && length(aws_route_table.database) == 0
    error_message = "Bring-your-own must create no network resources."
  }
  assert {
    condition     = output.vpc_id == "vpc-0byo" && output.private_subnet_ids == tolist(["subnet-a1", "subnet-a2"]) && output.public_subnet_ids == tolist(["subnet-p1", "subnet-p2"])
    error_message = "Outputs must pass the given VPC through."
  }
  assert {
    condition     = output.database_subnet_cidrs == tolist(["10.99.0.0/24", "10.99.0.0/24"])
    error_message = "Database CIDRs must be looked up from the given subnets."
  }
}
