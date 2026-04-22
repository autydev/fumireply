output "state_bucket_name" {
  description = "S3 bucket holding Terraform state files"
  value       = aws_s3_bucket.terraform_state.id
}

output "lock_table_name" {
  description = "DynamoDB table for state locking"
  value       = aws_dynamodb_table.terraform_locks.id
}

output "kms_key_arn" {
  description = "KMS key ARN used for state encryption"
  value       = aws_kms_key.terraform_state.arn
}
