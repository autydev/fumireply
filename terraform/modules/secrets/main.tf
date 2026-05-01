###############################################################################
# Module: secrets
#
# Creates SSM SecureString parameters for all runtime secrets.
# Values are placeholder strings; real values are injected manually via
# `aws ssm put-parameter --overwrite` after apply.
# `lifecycle.ignore_changes = [value]` keeps Terraform from reverting manual
# updates on subsequent applies.
###############################################################################

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

locals {
  review_prefix = "/fumireply/review"
}

resource "aws_ssm_parameter" "meta_app_secret" {
  name        = "${local.review_prefix}/meta/app-secret"
  description = "Meta App Secret for Webhook signature verification (shared across all tenants)"
  type        = "SecureString"
  value       = "placeholder"

  lifecycle {
    ignore_changes = [value]
  }

  tags = var.tags
}

resource "aws_ssm_parameter" "meta_webhook_verify_token" {
  name        = "${local.review_prefix}/meta/webhook-verify-token"
  description = "Webhook verify token for Meta subscription handshake (shared across all tenants)"
  type        = "SecureString"
  value       = "placeholder"

  lifecycle {
    ignore_changes = [value]
  }

  tags = var.tags
}

resource "aws_ssm_parameter" "supabase_url" {
  name        = "${local.review_prefix}/supabase/url"
  description = "Supabase project URL (e.g. https://xxxx.supabase.co)"
  type        = "SecureString"
  value       = "placeholder"

  lifecycle {
    ignore_changes = [value]
  }

  tags = var.tags
}

resource "aws_ssm_parameter" "supabase_publishable_key" {
  name        = "${local.review_prefix}/supabase/publishable-key"
  description = "Supabase publishable key (sb_publishable_..., RLS-aware client auth)"
  type        = "SecureString"
  value       = "placeholder"

  lifecycle {
    ignore_changes = [value]
  }

  tags = var.tags
}

resource "aws_ssm_parameter" "supabase_secret_key" {
  name        = "${local.review_prefix}/supabase/secret-key"
  description = "Supabase secret key (sb_secret_..., service_role / BYPASSRLS for admin operations)"
  type        = "SecureString"
  value       = "placeholder"

  lifecycle {
    ignore_changes = [value]
  }

  tags = var.tags
}

resource "aws_ssm_parameter" "supabase_db_url" {
  name        = "${local.review_prefix}/supabase/db-url"
  description = "Supabase Pooler connection string (anon role, Transaction mode, port 6543)"
  type        = "SecureString"
  value       = "placeholder"

  lifecycle {
    ignore_changes = [value]
  }

  tags = var.tags
}

resource "aws_ssm_parameter" "supabase_db_url_service_role" {
  name        = "${local.review_prefix}/supabase/db-url-service-role"
  description = "Supabase Pooler connection string (service role, bypasses RLS, Transaction mode, port 6543)"
  type        = "SecureString"
  value       = "placeholder"

  lifecycle {
    ignore_changes = [value]
  }

  tags = var.tags
}

resource "aws_ssm_parameter" "anthropic_api_key" {
  name        = "${local.review_prefix}/anthropic/api-key"
  description = "Anthropic API key for AI Worker Lambda"
  type        = "SecureString"
  value       = "placeholder"

  lifecycle {
    ignore_changes = [value]
  }

  tags = var.tags
}

resource "aws_ssm_parameter" "deletion_log_hash_salt" {
  name        = "${local.review_prefix}/deletion-log/hash-salt"
  description = "32-byte random salt for deletion_log.psid_hash computation"
  type        = "SecureString"
  value       = "placeholder"

  lifecycle {
    ignore_changes = [value]
  }

  tags = var.tags
}

# Note: master-encryption-key path intentionally omits env prefix to allow
# a single key to serve multiple environments without SSM path changes.
resource "aws_ssm_parameter" "master_encryption_key" {
  name        = "/fumireply/master-encryption-key"
  description = "AES-256 master key (32 bytes hex) for page_access_token_encrypted column"
  type        = "SecureString"
  value       = "placeholder"

  lifecycle {
    ignore_changes = [value]
  }

  tags = var.tags
}
