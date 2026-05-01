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
  description = "S3 key of the Lambda deployment package zip"
  type        = string
}
