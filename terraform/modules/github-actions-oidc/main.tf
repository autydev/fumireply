###############################################################################
# Module: github-actions-oidc
#
# IAM OIDC provider for GitHub Actions + scoped role.
# Grants CI workflows permission to:
#   - Run terraform plan/apply (via state S3 + DynamoDB lock)
#   - Update Lambda function code (4 functions)
#   - Sync static assets to S3
#   - Create CloudFront cache invalidations
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

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

###############################################################################
# GitHub OIDC provider
# thumbprint_list is the SHA-1 of the GitHub Actions TLS leaf certificate.
# GitHub rotates this periodically; the value below is current as of 2025.
###############################################################################

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = var.tags
}

###############################################################################
# IAM role assumed by GitHub Actions
###############################################################################

data "aws_iam_policy_document" "github_assume_role" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_org}/${var.github_repo}:*"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "github_actions" {
  name               = "${var.name_prefix}-github-actions-role"
  assume_role_policy = data.aws_iam_policy_document.github_assume_role.json
  tags               = var.tags
}

###############################################################################
# Policy: Terraform state access (plan + apply)
###############################################################################

data "aws_iam_policy_document" "github_actions_policy" {
  # Terraform state S3 read/write
  statement {
    sid = "TerraformStateS3"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]
    resources = [
      var.state_bucket_arn,
      "${var.state_bucket_arn}/*",
    ]
  }

  # Terraform state lock (DynamoDB)
  statement {
    sid = "TerraformStateLock"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
    ]
    resources = [
      "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/malbek-terraform-locks",
    ]
  }

  # Lambda: update function code only (4 functions)
  statement {
    sid       = "LambdaUpdateFunctionCode"
    actions   = ["lambda:UpdateFunctionCode"]
    resources = var.lambda_function_arns
  }

  # S3: sync static assets to static-site bucket
  statement {
    sid = "StaticSiteS3Sync"
    actions = [
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
      "s3:GetObject",
    ]
    resources = [
      var.static_s3_bucket_arn,
      "${var.static_s3_bucket_arn}/*",
    ]
  }

  # CloudFront: cache invalidation
  statement {
    sid = "CloudFrontInvalidation"
    actions = [
      "cloudfront:CreateInvalidation",
    ]
    resources = [var.cloudfront_distribution_arn]
  }

  # ECR / SSM read for plan validation (terraform plan reads SSM parameter names)
  statement {
    sid = "SSMDescribeForPlan"
    actions = [
      "ssm:DescribeParameters",
      "ssm:GetParameter",
      "ssm:GetParameters",
    ]
    resources = [
      "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter/fumireply/*",
    ]
  }
}

resource "aws_iam_role_policy" "github_actions" {
  name   = "${var.name_prefix}-github-actions-policy"
  role   = aws_iam_role.github_actions.id
  policy = data.aws_iam_policy_document.github_actions_policy.json
}
