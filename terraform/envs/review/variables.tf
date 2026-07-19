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

# NOTE: これらは実際にデプロイ済みの ACM 証明書 / CloudFront alias /
# Route53 A レコードと一致していなければならない。ズレたまま apply すると
# 証明書の再発行と DNS レコードの置き換えが走り、本番ドメインが停止する。
# main.tf の public_app_origin (ハードコード) とも揃えること。
variable "domain_name" {
  description = "Primary CloudFront domain"
  type        = string
  default     = "review.fumireply.ecsuite.work"
}

variable "additional_domain_names" {
  description = "Additional SAN entries on the ACM certificate"
  type        = list(string)
  default     = []
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
