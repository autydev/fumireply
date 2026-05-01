variable "name_prefix" {
  description = "Prefix for resource names (e.g. fumireply-review)"
  type        = string
}

variable "function_name_override" {
  description = "Optional explicit function name. When set, breaks the observability ↔ keep-alive cycle by letting the parent module pass the same literal name to both modules instead of routing through outputs. Defaults to '<name_prefix>-keep-alive'."
  type        = string
  default     = null
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

variable "sns_topic_arn" {
  description = "ARN of the observability SNS topic (failure notification, DLQ, OnFailure destination)"
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
