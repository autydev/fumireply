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

variable "lambda_package_s3_bucket" {
  description = "S3 bucket containing the Lambda deployment package"
  type        = string
}

variable "lambda_package_s3_key" {
  description = "S3 key of the Lambda deployment package zip"
  type        = string
}

variable "web_adapter_layer_arn" {
  description = "ARN of the Lambda Web Adapter layer (LambdaAdapterLayerX86)"
  type        = string
  default     = "arn:aws:lambda:ap-northeast-1:753240598075:layer:LambdaAdapterLayerX86:18"
}

# ───── 直接埋め込み: SSM SecureString から復号した値を Lambda env vars に注入 ─────
# app/src/server/env.ts の zod schema が要求する 5 つ。

variable "database_url" {
  description = "Supabase Postgres connection URL (pooler endpoint)"
  type        = string
  sensitive   = true
}

variable "database_url_service_role" {
  description = "Supabase Postgres connection URL with service_role credentials (system ops)"
  type        = string
  sensitive   = true
}

variable "supabase_url" {
  description = "Supabase project URL (https://<project-ref>.supabase.co)"
  type        = string
}

variable "supabase_publishable_key" {
  description = "Supabase anon (publishable) key"
  type        = string
  sensitive   = true
}

variable "supabase_secret_key" {
  description = "Supabase service_role (secret) key"
  type        = string
  sensitive   = true
}

# ───── 値ではなく SSM のキーパス: コード側がランタイムで getSsmParameter する ─────

variable "meta_app_secret_ssm_key" {
  description = "SSM parameter key path that stores the Meta App Secret (consumed at runtime)"
  type        = string
}

variable "webhook_verify_token_ssm_key" {
  description = "SSM parameter key path that stores the Meta webhook verify token"
  type        = string
}

variable "anthropic_api_key_ssm_key" {
  description = "SSM parameter key path that stores the Anthropic API key"
  type        = string
}
