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

variable "summary_queue_arn" {
  description = "ARN of the ai-summary SQS queue (second event source mapping). Leave empty to disable."
  type        = string
  default     = ""
}

variable "summary_event_source_enabled" {
  description = "Whether to create the SQS event source mapping for the summary queue. Must be statically known at plan time (cannot derive from summary_queue_arn because it's known-after-apply when the queue is freshly created)."
  type        = bool
  default     = false
}

variable "summary_queue_url" {
  description = "URL of the ai-summary SQS queue (injected as AI_SUMMARY_QUEUE_URL env var)."
  type        = string
  default     = ""
}

variable "summary_trigger_threshold_chars" {
  description = "Character threshold to trigger summary job (default 2000)."
  type        = string
  default     = "2000"
}

variable "summary_pipeline_enabled" {
  description = "Set to 'false' to disable the summary pipeline circuit-breaker."
  type        = string
  default     = "true"
}
