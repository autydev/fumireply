variable "name_prefix" {
  description = "Prefix for resource names (e.g. fumireply-review)"
  type        = string
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}

variable "github_org" {
  description = "GitHub organization or user name (e.g. autydev)"
  type        = string
}

variable "github_repo" {
  description = "GitHub repository name (e.g. fumireply)"
  type        = string
}

variable "state_bucket_arn" {
  description = "ARN of the Terraform state S3 bucket (grants terraform plan/apply access)"
  type        = string
}

variable "lambda_function_arns" {
  description = "ARNs of Lambda functions that CI can update-function-code"
  type        = list(string)
}

variable "static_s3_bucket_arn" {
  description = "ARN of the static site S3 bucket (CI syncs built assets here)"
  type        = string
}

variable "cloudfront_distribution_arn" {
  description = "ARN of the CloudFront distribution (CI creates invalidations)"
  type        = string
}
