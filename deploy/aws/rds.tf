# RDS for PostgreSQL, private, in the database tier, reachable only from system
# nodes. Workloads log in with IAM tokens (DATABASE_AUTH=rds-iam) over verified
# TLS; the parameter group refuses unencrypted connections. The master user's
# password is generated and kept by RDS in Secrets Manager and is used only to
# create the IAM database users and their grants.

resource "aws_security_group" "database" {
  name        = "${var.name_prefix}-database"
  description = "Postgres: admits system nodes only"
  vpc_id      = local.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "database_from_system_nodes" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.system_nodes.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres from system nodes"
}

resource "aws_db_subnet_group" "main" {
  name       = "${var.name_prefix}-database"
  subnet_ids = local.database_subnet_ids
}

resource "aws_db_parameter_group" "main" {
  name   = "${var.name_prefix}-postgres${var.database_engine_version}"
  family = "postgres${var.database_engine_version}"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # The name carries the major version, so a version change creates the new
  # group before the instance moves off the old one, which is deleted last.
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "main" {
  identifier     = var.name_prefix
  engine         = "postgres"
  engine_version = var.database_engine_version
  instance_class = var.database_instance_class

  allocated_storage     = var.database_allocated_storage_gb
  max_allocated_storage = var.database_max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name                     = var.database_name
  username                    = var.database_master_username
  manage_master_user_password = true

  iam_database_authentication_enabled = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.database.id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.main.name
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  multi_az                   = var.database_multi_az
  backup_retention_period    = var.database_backup_retention_days
  copy_tags_to_snapshot      = true
  auto_minor_version_upgrade = true

  # Changing database_engine_version is the operator's explicit request for a
  # major upgrade. It is applied in the maintenance window (apply_immediately
  # is left unset).
  allow_major_version_upgrade = true

  # Read from state at destroy time: apply false first, then destroy. The final
  # snapshot name is fixed, so a second destroy of a recreated instance needs the
  # old snapshot deleted first.
  deletion_protection       = var.database_deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name_prefix}-final"
}
