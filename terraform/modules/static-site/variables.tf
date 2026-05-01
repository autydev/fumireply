variable "name_prefix" {
  description = "Prefix for resource names (e.g. fumireply-review)"
  type        = string
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}

variable "domain_name" {
  description = "Primary domain name for the CloudFront distribution (e.g. review.malbek.co.jp)"
  type        = string
}

variable "additional_domain_names" {
  description = "Additional domain names to include in the ACM certificate (e.g. malbek.co.jp)"
  type        = list(string)
  default     = []
}

variable "api_gateway_invoke_url" {
  description = "Invoke URL of the app-lambda HTTP API (dynamic origin)"
  type        = string
}

variable "route53_zone_id" {
  description = "Route53 hosted zone ID for the domain"
  type        = string
}
