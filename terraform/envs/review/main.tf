###############################################################################
# Review environment — wires every module from terraform/modules/.
#
# Cycle break: observability needs each Lambda function name; keep-alive needs
# the SNS topic ARN. We give the keep-alive function a literal name via a local
# value, pass that same literal to observability, and let observability create
# the SNS topic that keep-alive consumes through `sns_topic_arn`.
###############################################################################

locals {
  common_tags = {
    Project     = "fumireply"
    Environment = "review"
    ManagedBy   = "terraform"
  }

  # Literal Lambda names. observability + keep-alive both reference these
  # without going through module outputs, breaking the would-be cycle.
  app_lambda_function_name        = "${var.name_prefix}-app"
  webhook_lambda_function_name    = "${var.name_prefix}-webhook"
  ai_worker_lambda_function_name  = "${var.name_prefix}-ai-worker"
  keep_alive_lambda_function_name = "${var.name_prefix}-keep-alive"

  lambda_artifacts_bucket = "${var.name_prefix}-lambda-artifacts"

  # Initial deploy uses a placeholder zip uploaded by Terraform itself.
  # CI overwrites the live function code via `aws lambda update-function-code`,
  # so the s3 object's content drift is intentional and ignored downstream.
  placeholder_s3_key = "placeholder/bootstrap.zip"
}

###############################################################################
# Lambda artifacts bucket (placeholder zip lives here until CI ships real code)
###############################################################################

resource "aws_s3_bucket" "lambda_artifacts" {
  bucket = local.lambda_artifacts_bucket
}

resource "aws_s3_bucket_versioning" "lambda_artifacts" {
  bucket = aws_s3_bucket.lambda_artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "lambda_artifacts" {
  bucket                  = aws_s3_bucket.lambda_artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "archive_file" "placeholder" {
  type        = "zip"
  output_path = "${path.module}/.terraform/placeholder.zip"

  source {
    # Lambda Web Adapter expects a `bootstrap` entrypoint; for non-adapter
    # Lambdas the runtime won't invoke this anyway before CI replaces it.
    filename = "bootstrap"
    content  = "#!/bin/sh\necho 'placeholder lambda — replace via CI deploy'\nexit 0\n"
  }
}

resource "aws_s3_object" "placeholder" {
  bucket = aws_s3_bucket.lambda_artifacts.id
  key    = local.placeholder_s3_key
  source = data.archive_file.placeholder.output_path
  etag   = data.archive_file.placeholder.output_md5
}

###############################################################################
# Secrets / SSM
###############################################################################

module "secrets" {
  source = "../../modules/secrets"

  name_prefix = var.name_prefix
}

###############################################################################
# Queue (SQS + DLQ)
###############################################################################

module "queue" {
  source = "../../modules/queue"

  name_prefix = var.name_prefix
}

###############################################################################
# App Lambda + API Gateway HTTP API (shared with webhook)
###############################################################################

###############################################################################
# Read SSM SecureString values to inject as Lambda env vars
# (app の env.ts は process.env を直接読むため、起動時に値を持っている必要がある)
###############################################################################

data "aws_ssm_parameter" "supabase_url" {
  name = "/fumireply/review/supabase/url"
}

data "aws_ssm_parameter" "supabase_publishable_key" {
  name = "/fumireply/review/supabase/publishable-key"
}

data "aws_ssm_parameter" "supabase_secret_key" {
  name = "/fumireply/review/supabase/secret-key"
}

data "aws_ssm_parameter" "supabase_db_url" {
  name = "/fumireply/review/supabase/db-url"
}

data "aws_ssm_parameter" "supabase_db_url_service_role" {
  name = "/fumireply/review/supabase/db-url-service-role"
}

module "app_lambda" {
  source = "../../modules/app-lambda"

  name_prefix              = var.name_prefix
  ssm_path_prefix          = module.secrets.ssm_path_prefix
  lambda_package_s3_bucket = aws_s3_bucket.lambda_artifacts.id
  lambda_package_s3_key    = aws_s3_object.placeholder.key

  # 直接埋め込む値（SSM SecureString から復号して Lambda env vars に注入）
  database_url              = data.aws_ssm_parameter.supabase_db_url.value
  database_url_service_role = data.aws_ssm_parameter.supabase_db_url_service_role.value
  supabase_url              = data.aws_ssm_parameter.supabase_url.value
  supabase_publishable_key  = data.aws_ssm_parameter.supabase_publishable_key.value
  supabase_secret_key       = data.aws_ssm_parameter.supabase_secret_key.value

  # 値ではなく SSM のキーパス（コード側がランタイムで読む）
  meta_app_secret_ssm_key      = "/fumireply/review/meta/app-secret"
  webhook_verify_token_ssm_key = "/fumireply/review/meta/webhook-verify-token"
  anthropic_api_key_ssm_key    = "/fumireply/review/anthropic/api-key"
}

###############################################################################
# Webhook Lambda (shares the app-lambda HTTP API)
###############################################################################

module "webhook_lambda" {
  source = "../../modules/webhook-lambda"

  name_prefix               = var.name_prefix
  ssm_path_prefix           = module.secrets.ssm_path_prefix
  sqs_queue_arn             = module.queue.queue_arn
  sqs_queue_url             = module.queue.queue_url
  api_gateway_id            = module.app_lambda.api_gateway_id
  api_gateway_execution_arn = module.app_lambda.api_gateway_execution_arn
  lambda_package_s3_bucket  = aws_s3_bucket.lambda_artifacts.id
  lambda_package_s3_key     = aws_s3_object.placeholder.key
}

###############################################################################
# AI Worker Lambda (SQS event source)
###############################################################################

module "ai_worker_lambda" {
  source = "../../modules/ai-worker-lambda"

  name_prefix              = var.name_prefix
  ssm_path_prefix          = module.secrets.ssm_path_prefix
  sqs_queue_arn            = module.queue.queue_arn
  lambda_package_s3_bucket = aws_s3_bucket.lambda_artifacts.id
  lambda_package_s3_key    = aws_s3_object.placeholder.key

  database_url              = data.aws_ssm_parameter.supabase_db_url.value
  database_url_service_role = data.aws_ssm_parameter.supabase_db_url_service_role.value
}

###############################################################################
# Observability (created BEFORE keep-alive so its SNS topic ARN is available)
###############################################################################

module "observability" {
  source = "../../modules/observability"

  name_prefix                     = var.name_prefix
  app_lambda_function_name        = local.app_lambda_function_name
  webhook_lambda_function_name    = local.webhook_lambda_function_name
  ai_worker_lambda_function_name  = local.ai_worker_lambda_function_name
  keep_alive_lambda_function_name = local.keep_alive_lambda_function_name
  ai_draft_dlq_arn                = module.queue.dlq_arn
  alert_email                     = var.alert_email
}

###############################################################################
# Keep-alive Lambda (consumes SNS topic ARN from observability)
###############################################################################

module "keep_alive_lambda" {
  source = "../../modules/keep-alive-lambda"

  name_prefix              = var.name_prefix
  function_name_override   = local.keep_alive_lambda_function_name
  ssm_path_prefix          = module.secrets.ssm_path_prefix
  sns_topic_arn            = module.observability.sns_topic_arn
  lambda_package_s3_bucket = aws_s3_bucket.lambda_artifacts.id
  lambda_package_s3_key    = aws_s3_object.placeholder.key
}

###############################################################################
# Static site (CloudFront + S3 + ACM in us-east-1)
###############################################################################

module "static_site" {
  source = "../../modules/static-site"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name_prefix             = var.name_prefix
  domain_name             = var.domain_name
  additional_domain_names = var.additional_domain_names
  api_gateway_invoke_url  = module.app_lambda.api_gateway_invoke_url
  route53_zone_id         = var.route53_zone_id
}

###############################################################################
# GitHub Actions OIDC role
###############################################################################

module "github_actions_oidc" {
  source = "../../modules/github-actions-oidc"

  name_prefix      = var.name_prefix
  github_org       = var.github_org
  github_repo      = var.github_repo
  state_bucket_arn = var.state_bucket_arn

  lambda_function_arns = [
    module.app_lambda.lambda_function_arn,
    module.webhook_lambda.lambda_function_arn,
    module.ai_worker_lambda.lambda_function_arn,
    module.keep_alive_lambda.lambda_function_arn,
  ]

  static_s3_bucket_arn        = module.static_site.s3_bucket_arn
  lambda_artifacts_bucket_arn = aws_s3_bucket.lambda_artifacts.arn
  cloudfront_distribution_arn = module.static_site.cloudfront_distribution_arn
}

###############################################################################
# Outputs
###############################################################################

output "app_lambda_arn" {
  value = module.app_lambda.lambda_function_arn
}

output "webhook_lambda_arn" {
  value = module.webhook_lambda.lambda_function_arn
}

output "ai_worker_lambda_arn" {
  value = module.ai_worker_lambda.lambda_function_arn
}

output "keep_alive_lambda_arn" {
  value = module.keep_alive_lambda.lambda_function_arn
}

output "api_gateway_invoke_url" {
  value = module.app_lambda.api_gateway_invoke_url
}

output "cloudfront_domain_name" {
  value = module.static_site.cloudfront_domain_name
}

output "static_s3_bucket_name" {
  value = module.static_site.s3_bucket_name
}

output "lambda_artifacts_bucket" {
  value = aws_s3_bucket.lambda_artifacts.id
}

output "ai_draft_queue_url" {
  value = module.queue.queue_url
}

output "ai_draft_queue_arn" {
  value = module.queue.queue_arn
}

output "github_actions_role_arn" {
  value = module.github_actions_oidc.role_arn
}
