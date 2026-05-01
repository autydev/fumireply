###############################################################################
# Module: webhook-lambda
#
# Meta Webhook receiver Lambda + GET/POST /api/webhook routes on the shared
# API Gateway created by the app-lambda module.
# No Lambda Web Adapter — receives API Gateway HTTP API proxy events directly.
# Build: `cd webhook && npm run build` produces dist/handler.js (CJS bundle).
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

resource "aws_iam_role" "webhook_lambda" {
  name               = "${var.name_prefix}-webhook-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
  tags               = var.tags
}

data "aws_iam_policy_document" "webhook_lambda_policy" {
  statement {
    sid       = "SSMRead"
    actions   = ["ssm:GetParameter"]
    resources = ["${local.ssm_arn_prefix}/*"]
  }

  statement {
    sid       = "SQSSendMessage"
    actions   = ["sqs:SendMessage"]
    resources = [var.sqs_queue_arn]
  }

  statement {
    sid = "CloudWatchLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${aws_cloudwatch_log_group.webhook_lambda.arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "webhook_lambda" {
  name   = "${var.name_prefix}-webhook-lambda-policy"
  role   = aws_iam_role.webhook_lambda.id
  policy = data.aws_iam_policy_document.webhook_lambda_policy.json
}

###############################################################################
# CloudWatch Log Group
###############################################################################

resource "aws_cloudwatch_log_group" "webhook_lambda" {
  name              = "/aws/lambda/${var.name_prefix}-webhook"
  retention_in_days = 30
  tags              = var.tags
}

###############################################################################
# Lambda Function
###############################################################################

resource "aws_lambda_function" "webhook" {
  function_name = "${var.name_prefix}-webhook"
  role          = aws_iam_role.webhook_lambda.arn
  runtime       = "nodejs22.x"
  handler       = "handler.handler"
  memory_size   = 512
  timeout       = 10

  s3_bucket = var.lambda_package_s3_bucket
  s3_key    = var.lambda_package_s3_key

  environment {
    variables = {
      SSM_PATH_PREFIX = var.ssm_path_prefix
      SQS_QUEUE_URL   = var.sqs_queue_url
    }
  }

  depends_on = [aws_cloudwatch_log_group.webhook_lambda]

  tags = var.tags
}

###############################################################################
# API Gateway routes (injected into the shared HTTP API)
# Only /api/webhook is handled here; all other /api/* routes go to app-lambda.
###############################################################################

resource "aws_apigatewayv2_integration" "webhook_lambda" {
  api_id                 = var.api_gateway_id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.webhook.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "webhook_get" {
  api_id    = var.api_gateway_id
  route_key = "GET /api/webhook"
  target    = "integrations/${aws_apigatewayv2_integration.webhook_lambda.id}"
}

resource "aws_apigatewayv2_route" "webhook_post" {
  api_id    = var.api_gateway_id
  route_key = "POST /api/webhook"
  target    = "integrations/${aws_apigatewayv2_integration.webhook_lambda.id}"
}

resource "aws_lambda_permission" "apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.webhook.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${var.api_gateway_execution_arn}/*/*/api/webhook"
}
