variable "name_prefix" {
  description = "Prefix for resource names (e.g. fumireply-review)"
  type        = string
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}

variable "ssm_path_prefix" {
  description = "SSM parameter path prefix (e.g. /fumireply/review/)"
  type        = string
}

variable "sqs_queue_arn" {
  description = "ARN of the AI draft SQS queue (event source mapping)"
  type        = string
}

variable "lambda_package_s3_bucket" {
  description = "S3 bucket containing the Lambda deployment package"
  type        = string
}

variable "lambda_package_s3_key" {
  description = "S3 key of the Lambda deployment package zip"
  type        = string
}

variable "database_url" {
  description = "Supabase Postgres connection string for anon role (RLS enforced)"
  type        = string
  sensitive   = true
}

variable "database_url_service_role" {
  description = "Supabase Postgres connection string for service role (bypasses RLS, used for tenant_id resolution)"
  type        = string
  sensitive   = true
}
