# The network: three tiers across up to three availability zones.
#
#   public   -- the internet-facing load balancer and the NAT gateway(s)
#   private  -- EKS nodes and pods (the VPC CNI gives every pod a VPC address,
#               so these get most of the address space)
#   database -- RDS only, with no route out of the VPC at all
#
# With existing_vpc_id, none of this is created and the given subnets are used.

locals {
  create_vpc = var.existing_vpc_id == null

  azs   = slice(data.aws_availability_zones.available.names, 0, min(3, length(data.aws_availability_zones.available.names)))
  zones = local.create_vpc ? { for i, az in local.azs : az => i } : {}

  # One NAT gateway in the first zone, or one per zone.
  nat_zones = local.create_vpc ? (var.single_nat_gateway ? { (local.azs[0]) = 0 } : local.zones) : {}

  vpc_id              = local.create_vpc ? aws_vpc.main[0].id : var.existing_vpc_id
  public_subnet_ids   = local.create_vpc ? [for az in local.azs : aws_subnet.public[az].id] : var.existing_public_subnet_ids
  private_subnet_ids  = local.create_vpc ? [for az in local.azs : aws_subnet.private[az].id] : var.existing_private_subnet_ids
  database_subnet_ids = local.create_vpc ? [for az in local.azs : aws_subnet.database[az].id] : var.existing_database_subnet_ids
  database_subnet_cidrs = (
    local.create_vpc
    ? [for az in local.azs : aws_subnet.database[az].cidr_block]
    : [for id in var.existing_database_subnet_ids : data.aws_subnet.database[id].cidr_block]
  )
}

data "aws_availability_zones" "available" {
  state = "available"

  # Regular zones only: Local Zones and Wavelength Zones lack EKS and RDS.
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

data "aws_subnet" "database" {
  for_each = local.create_vpc ? toset([]) : toset(var.existing_database_subnet_ids)
  id       = each.value
}

resource "aws_vpc" "main" {
  count = local.create_vpc ? 1 : 0

  cidr_block = var.vpc_cidr
  # Both are required for the EKS private API endpoint to resolve inside the VPC.
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.name_prefix }
}

resource "aws_internet_gateway" "main" {
  count  = local.create_vpc ? 1 : 0
  vpc_id = aws_vpc.main[0].id
  tags   = { Name = var.name_prefix }
}

# Layout for a /16: private /18s at .0, .64, .128; public /22s at .192-.203;
# database /22s at .208-.219. Smaller VPCs scale the same way.
resource "aws_subnet" "private" {
  for_each = local.zones

  vpc_id            = aws_vpc.main[0].id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 2, each.value)

  tags = {
    Name                              = "${var.name_prefix}-private-${each.key}"
    "kubernetes.io/role/internal-elb" = "1"
  }
}

resource "aws_subnet" "public" {
  for_each = local.zones

  vpc_id                  = aws_vpc.main[0].id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 6, 48 + each.value)
  map_public_ip_on_launch = false

  tags = {
    Name                     = "${var.name_prefix}-public-${each.key}"
    "kubernetes.io/role/elb" = "1"
  }
}

resource "aws_subnet" "database" {
  for_each = local.zones

  vpc_id            = aws_vpc.main[0].id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 6, 52 + each.value)

  tags = { Name = "${var.name_prefix}-database-${each.key}" }
}

resource "aws_route_table" "public" {
  count  = local.create_vpc ? 1 : 0
  vpc_id = aws_vpc.main[0].id
  tags   = { Name = "${var.name_prefix}-public" }
}

resource "aws_route" "public_internet" {
  count = local.create_vpc ? 1 : 0

  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main[0].id
}

resource "aws_route_table_association" "public" {
  for_each       = local.zones
  subnet_id      = aws_subnet.public[each.key].id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_eip" "nat" {
  for_each = local.nat_zones
  domain   = "vpc"
  tags     = { Name = "${var.name_prefix}-nat-${each.key}" }
}

resource "aws_nat_gateway" "main" {
  for_each = local.nat_zones

  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = aws_subnet.public[each.key].id
  tags          = { Name = "${var.name_prefix}-${each.key}" }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "private" {
  for_each = local.zones
  vpc_id   = aws_vpc.main[0].id
  tags     = { Name = "${var.name_prefix}-private-${each.key}" }
}

resource "aws_route" "private_nat" {
  for_each = local.zones

  route_table_id         = aws_route_table.private[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = var.single_nat_gateway ? aws_nat_gateway.main[local.azs[0]].id : aws_nat_gateway.main[each.key].id
}

resource "aws_route_table_association" "private" {
  for_each       = local.zones
  subnet_id      = aws_subnet.private[each.key].id
  route_table_id = aws_route_table.private[each.key].id
}

# The database tier's table has only the implicit local route: nothing in it can
# reach, or be reached from, outside the VPC.
resource "aws_route_table" "database" {
  count  = local.create_vpc ? 1 : 0
  vpc_id = aws_vpc.main[0].id
  tags   = { Name = "${var.name_prefix}-database" }
}

resource "aws_route_table_association" "database" {
  for_each       = local.zones
  subnet_id      = aws_subnet.database[each.key].id
  route_table_id = aws_route_table.database[0].id
}
