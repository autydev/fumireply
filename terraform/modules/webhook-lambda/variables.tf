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
  description = "ARN of the AI draft SQS queue for SendMessage permission"
  type        = string
}

variable "sqs_queue_url" {
  description = "URL of the AI draft SQS queue (injected as env var)"
  type        = string
}

variable "api_gateway_id" {
  description = "ID of the shared HTTP API (from app-lambda module)"
  type        = string
}

variable "api_gateway_execution_arn" {
  description = "Execution ARN of the shared HTTP API (for Lambda permission)"
  type        = string
}

variable "lambda_package_s3_bucket" {
  description = "S3 bucket containing the Lambda deployment package"
  type        = string
}

variable "lambda_package_s3_key" {
  description = "S3 key of the Lambda deployment package zip (built from webhook/dist/)"
  type        = string
}

variable "master_key_ssm_arn" {
  description = "ARN of the master encryption key SSM parameter (lives outside ssm_path_prefix)"
  type        = string
}

variable "summary_queue_url" {
  description = "URL of the summary SQS queue (injected as AI_SUMMARY_QUEUE_URL env var)"
  type        = string
  default     = ""
}

variable "summary_queue_arn" {
  description = "ARN of the summary SQS queue (for sqs:SendMessage IAM)"
  type        = string
  default     = ""
}

variable "summary_trigger_threshold_chars" {
  description = "Char count threshold to trigger summary job"
  type        = string
  default     = "2000"
}

variable "summary_pipeline_enabled" {
  description = "Set to 'false' to disable the summary pipeline circuit-breaker"
  type        = string
  default     = "true"
}
