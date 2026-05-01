variable "region" {
  description = "Primary AWS region for the review environment"
  type        = string
  default     = "ap-northeast-1"
}

variable "name_prefix" {
  description = "Prefix applied to all resource names"
  type        = string
  default     = "fumireply-review"
}

variable "ssm_path_prefix" {
  description = "SSM Parameter Store path prefix (must end with '/')"
  type        = string
  default     = "/fumireply/review/"
}

variable "alert_email" {
  description = "Email address subscribed to the observability SNS topic"
  type        = string
}

variable "domain_name" {
  description = "Primary CloudFront domain (e.g. review.malbek.co.jp)"
  type        = string
  default     = "review.malbek.co.jp"
}

variable "additional_domain_names" {
  description = "Additional SAN entries on the ACM certificate"
  type        = list(string)
  default     = ["malbek.co.jp"]
}

variable "route53_zone_id" {
  description = "Route53 hosted zone ID that owns domain_name"
  type        = string
}

variable "github_org" {
  description = "GitHub organization that owns the repository (OIDC trust)"
  type        = string
  default     = "autydev"
}

variable "github_repo" {
  description = "GitHub repository name (OIDC trust)"
  type        = string
  default     = "fumireply"
}

variable "state_bucket_arn" {
  description = "ARN of the Terraform state S3 bucket (granted to the GitHub Actions role)"
  type        = string
  default     = "arn:aws:s3:::malbek-terraform-state"
}
