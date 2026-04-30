variable "name_prefix" {
  description = "Prefix for resource names (e.g. fumireply-review)"
  type        = string
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}

variable "app_lambda_function_name" {
  description = "Name of the app Lambda function"
  type        = string
}

variable "webhook_lambda_function_name" {
  description = "Name of the webhook Lambda function"
  type        = string
}

variable "ai_worker_lambda_function_name" {
  description = "Name of the AI worker Lambda function"
  type        = string
}

variable "keep_alive_lambda_function_name" {
  description = "Name of the keep-alive Lambda function"
  type        = string
}

variable "ai_draft_dlq_arn" {
  description = "ARN of the AI draft dead-letter queue"
  type        = string
}

variable "alert_email" {
  description = "Email address to receive CloudWatch alarm notifications"
  type        = string
}
