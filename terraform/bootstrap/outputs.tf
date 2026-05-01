output "state_bucket_name" {
  description = "S3 bucket holding Terraform state files"
  value       = aws_s3_bucket.terraform_state.id
}

output "kms_key_arn" {
  description = "KMS key ARN used for state encryption"
  value       = aws_kms_key.terraform_state.arn
}
