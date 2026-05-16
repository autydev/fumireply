output "ssm_path_prefix" {
  description = "SSM path prefix for runtime parameter reads"
  value       = "/fumireply/review/"
}

output "master_key_ssm_arn" {
  description = "ARN of the master encryption key SSM parameter"
  value       = aws_ssm_parameter.master_encryption_key.arn
}
