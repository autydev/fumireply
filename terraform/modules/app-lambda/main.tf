###############################################################################
# Module: app-lambda
#
# TanStack Start SSR Lambda (Lambda Web Adapter) + API Gateway HTTP API.
# The $default route catches all traffic except the paths claimed by the
# webhook-lambda module (GET/POST /api/webhook), which are added as separate
# integrations on the same API.
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
  # Strip leading/trailing slash so we can compose a valid SSM ARN
  # (parameter ARNs use a leading slash before the name).
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

resource "aws_iam_role" "app_lambda" {
  name               = "${var.name_prefix}-app-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
  tags               = var.tags
}

data "aws_iam_policy_document" "app_lambda_policy" {
  statement {
    sid     = "SSMRead"
    actions = ["ssm:GetParameter"]
    resources = [
      "${local.ssm_arn_prefix}/*",
      "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter/fumireply/master-encryption-key",
    ]
  }

  statement {
    sid = "CloudWatchLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${aws_cloudwatch_log_group.app_lambda.arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "app_lambda" {
  name   = "${var.name_prefix}-app-lambda-policy"
  role   = aws_iam_role.app_lambda.id
  policy = data.aws_iam_policy_document.app_lambda_policy.json
}

###############################################################################
# CloudWatch Log Group
###############################################################################

resource "aws_cloudwatch_log_group" "app_lambda" {
  name              = "/aws/lambda/${var.name_prefix}-app"
  retention_in_days = 30
  tags              = var.tags
}

###############################################################################
# Lambda Function
###############################################################################

resource "aws_lambda_function" "app" {
  function_name = "${var.name_prefix}-app"
  role          = aws_iam_role.app_lambda.arn
  runtime       = "nodejs22.x"
  handler       = "run.sh"
  memory_size   = 1024
  timeout       = 30

  s3_bucket = var.lambda_package_s3_bucket
  s3_key    = var.lambda_package_s3_key

  layers = [var.web_adapter_layer_arn]

  environment {
    variables = {
      AWS_LAMBDA_EXEC_WRAPPER = "/opt/bootstrap"
      PORT                    = "8080"
      NODE_ENV                = "production"
      SSM_PATH_PREFIX         = var.ssm_path_prefix

      # app/src/server/env.ts の zod schema が要求する env (AWS_REGION は Lambda runtime が自動セット)
      DATABASE_URL                 = var.database_url
      DATABASE_URL_SERVICE_ROLE    = var.database_url_service_role
      SUPABASE_URL                 = var.supabase_url
      SUPABASE_PUBLISHABLE_KEY     = var.supabase_publishable_key
      SUPABASE_SECRET_KEY          = var.supabase_secret_key
      META_APP_SECRET_SSM_KEY      = var.meta_app_secret_ssm_key
      WEBHOOK_VERIFY_TOKEN_SSM_KEY = var.webhook_verify_token_ssm_key
      ANTHROPIC_API_KEY_SSM_KEY    = var.anthropic_api_key_ssm_key
    }
  }

  depends_on = [aws_cloudwatch_log_group.app_lambda]

  tags = var.tags
}

###############################################################################
# API Gateway HTTP API
###############################################################################

resource "aws_apigatewayv2_api" "app" {
  name          = "${var.name_prefix}-api"
  protocol_type = "HTTP"
  tags          = var.tags
}

resource "aws_apigatewayv2_integration" "app_lambda" {
  api_id                 = aws_apigatewayv2_api.app.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.app.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.app.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.app_lambda.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.app.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apigw.arn
    format = jsonencode({
      requestId        = "$context.requestId"
      ip               = "$context.identity.sourceIp"
      requestTime      = "$context.requestTime"
      httpMethod       = "$context.httpMethod"
      routeKey         = "$context.routeKey"
      status           = "$context.status"
      protocol         = "$context.protocol"
      responseLength   = "$context.responseLength"
      integrationError = "$context.integrationErrorMessage"
    })
  }

  tags = var.tags
}

resource "aws_cloudwatch_log_group" "apigw" {
  name              = "/aws/apigateway/${var.name_prefix}-api"
  retention_in_days = 30
  tags              = var.tags
}

resource "aws_lambda_permission" "apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.app.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.app.execution_arn}/*/*"
}
