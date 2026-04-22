###############################################################################
# Bootstrap: Terraform state backend resources.
#
# Apply this directory ONCE with local state. After apply, the S3 bucket and
# DynamoDB lock table created here serve as the remote backend for
# `terraform/envs/review` (see ../envs/review/backend.tf).
#
# Never re-apply this against an existing backend without a recovery plan —
# the state bucket holds the tfstate of every downstream env.
###############################################################################

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # No backend block here: bootstrap uses local state.
}

provider "aws" {
  region = var.region
}

variable "region" {
  description = "AWS region for state bucket and lock table"
  type        = string
  default     = "ap-northeast-1"
}

variable "state_bucket_name" {
  description = "S3 bucket holding Terraform state files across projects"
  type        = string
  default     = "malbek-terraform-state"
}

variable "lock_table_name" {
  description = "DynamoDB table name for state locking"
  type        = string
  default     = "malbek-terraform-locks"
}

###############################################################################
# KMS key for state encryption
###############################################################################

resource "aws_kms_key" "terraform_state" {
  description             = "KMS key for Terraform state encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "terraform_state" {
  name          = "alias/terraform-state"
  target_key_id = aws_kms_key.terraform_state.key_id
}

###############################################################################
# S3 bucket for state files
###############################################################################

resource "aws_s3_bucket" "terraform_state" {
  bucket = var.state_bucket_name
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.terraform_state.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket                  = aws_s3_bucket.terraform_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

###############################################################################
# DynamoDB table for state locking
###############################################################################

resource "aws_dynamodb_table" "terraform_locks" {
  name         = var.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}
