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
