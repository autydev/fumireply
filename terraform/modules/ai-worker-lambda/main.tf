###############################################################################
# Module: ai-worker-lambda
#
# AI draft generation Worker Lambda triggered by SQS.
# Batch size 1 so a single processing failure does not affect other messages.
# Does NOT call Send API — only writes ai_drafts.body (human-in-the-loop required).
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

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  ssm_path_clean = trim(var.ssm_path_prefix, "/")
  ssm_arn_prefix = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter/${local.ssm_path_clean}"
}

###############################################################################
# IAM role
###############################################################################

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ai_worker_lambda" {
  name               = "${var.name_prefix}-ai-worker-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
  tags               = var.tags
}

data "aws_iam_policy_document" "ai_worker_lambda_policy" {
  statement {
    sid       = "SSMRead"
    actions   = ["ssm:GetParameter"]
    resources = ["${local.ssm_arn_prefix}/*"]
  }

  statement {
    sid = "SQSConsume"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = [var.sqs_queue_arn]
  }

  statement {
    sid = "CloudWatchLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${aws_cloudwatch_log_group.ai_worker_lambda.arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "ai_worker_lambda" {
  name   = "${var.name_prefix}-ai-worker-lambda-policy"
  role   = aws_iam_role.ai_worker_lambda.id
  policy = data.aws_iam_policy_document.ai_worker_lambda_policy.json
}

###############################################################################
# CloudWatch Log Group
###############################################################################

resource "aws_cloudwatch_log_group" "ai_worker_lambda" {
  name              = "/aws/lambda/${var.name_prefix}-ai-worker"
  retention_in_days = 30
  tags              = var.tags
}

###############################################################################
# Lambda Function
###############################################################################

resource "aws_lambda_function" "ai_worker" {
  function_name = "${var.name_prefix}-ai-worker"
  role          = aws_iam_role.ai_worker_lambda.arn
  runtime       = "nodejs22.x"
  handler       = "dist/handler.handler"
  memory_size   = 512
  timeout       = 60

  s3_bucket = var.lambda_package_s3_bucket
  s3_key    = var.lambda_package_s3_key

  environment {
    variables = {
      SSM_PATH_PREFIX = var.ssm_path_prefix
      ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"
    }
  }

  depends_on = [aws_cloudwatch_log_group.ai_worker_lambda]

  tags = var.tags
}

###############################################################################
# SQS Event Source Mapping
###############################################################################

resource "aws_lambda_event_source_mapping" "sqs" {
  event_source_arn = var.sqs_queue_arn
  function_name    = aws_lambda_function.ai_worker.arn
  batch_size       = 1
}
