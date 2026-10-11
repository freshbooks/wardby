terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.64"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.5"
    }
    cloudinit = {
      source  = "hashicorp/cloudinit"
      version = "~> 2.3"
    }
  }
}

provider "aws" {
  region = var.region

  # Every resource carries the deployment's name, so a shared account can tell
  # deployments apart in Cost Explorer and the console.
  default_tags {
    tags = merge({ "wardby:deployment" = var.name_prefix }, var.tags)
  }
}
