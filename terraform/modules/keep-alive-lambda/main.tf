###############################################################################
# Module: keep-alive-lambda
#
# Fires once per day to keep the Supabase free-plan DB awake (FR-027).
# Multiple failure paths: Lambda internal retry → EventBridge retry →
# OnFailure Destination → dead_letter_config → CloudWatch alarms (in observability module).
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
  function_name = coalesce(var.function_name_override, "${var.name_prefix}-keep-alive")
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

resource "aws_iam_role" "keep_alive_lambda" {
  name               = "${var.name_prefix}-keep-alive-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
  tags               = var.tags
}

data "aws_iam_policy_document" "keep_alive_lambda_policy" {
  statement {
    sid     = "SSMRead"
    actions = ["ssm:GetParameter"]
    resources = [
      "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter/fumireply/review/*",
    ]
  }

  statement {
    sid       = "SNSPublish"
    actions   = ["sns:Publish"]
    resources = [var.sns_topic_arn]
  }

  statement {
    sid = "CloudWatchLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${aws_cloudwatch_log_group.keep_alive_lambda.arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "keep_alive_lambda" {
  name   = "${var.name_prefix}-keep-alive-lambda-policy"
  role   = aws_iam_role.keep_alive_lambda.id
  policy = data.aws_iam_policy_document.keep_alive_lambda_policy.json
}

###############################################################################
# CloudWatch Log Group
###############################################################################

resource "aws_cloudwatch_log_group" "keep_alive_lambda" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = 365
  tags              = var.tags
}

###############################################################################
# Lambda Function
###############################################################################

resource "aws_lambda_function" "keep_alive" {
  function_name = local.function_name
  role          = aws_iam_role.keep_alive_lambda.arn
  runtime       = "nodejs24.x"
  handler       = "dist/handler.handler"
  memory_size   = 256
  timeout       = 30

  s3_bucket = var.lambda_package_s3_bucket
  s3_key    = var.lambda_package_s3_key

  environment {
    variables = {
      SSM_PATH_PREFIX = var.ssm_path_prefix
      SNS_TOPIC_ARN   = var.sns_topic_arn
    }
  }

  dead_letter_config {
    target_arn = var.sns_topic_arn
  }

  depends_on = [aws_cloudwatch_log_group.keep_alive_lambda]

  tags = var.tags
}

###############################################################################
# Lambda OnFailure Destination
###############################################################################

resource "aws_lambda_function_event_invoke_config" "keep_alive" {
  function_name                = aws_lambda_function.keep_alive.function_name
  maximum_retry_attempts       = 0 # EventBridge handles retries; Lambda async retries disabled
  maximum_event_age_in_seconds = 3600

  destination_config {
    on_failure {
      destination = var.sns_topic_arn
    }
  }
}

###############################################################################
# EventBridge Scheduled Rule
###############################################################################

resource "aws_cloudwatch_event_rule" "keep_alive" {
  name                = "${local.function_name}-schedule"
  description         = "Trigger keep-alive Lambda once per day to prevent Supabase free-plan pause"
  schedule_expression = "rate(1 day)"
  tags                = var.tags
}

resource "aws_cloudwatch_event_target" "keep_alive" {
  rule      = aws_cloudwatch_event_rule.keep_alive.name
  target_id = "KeepAliveLambda"
  arn       = aws_lambda_function.keep_alive.arn

  retry_policy {
    maximum_retry_attempts       = 2
    maximum_event_age_in_seconds = 3600
  }
}

resource "aws_lambda_permission" "eventbridge_invoke" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.keep_alive.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.keep_alive.arn
}
