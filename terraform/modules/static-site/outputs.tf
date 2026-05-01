output "cloudfront_distribution_id" {
  description = "ID of the CloudFront distribution (used for cache invalidation in deploy pipeline)"
  value       = aws_cloudfront_distribution.app.id
}

output "cloudfront_distribution_arn" {
  description = "ARN of the CloudFront distribution (passed to github-actions-oidc for invalidation permission)"
  value       = aws_cloudfront_distribution.app.arn
}

output "cloudfront_domain_name" {
  description = "Domain name of the CloudFront distribution"
  value       = aws_cloudfront_distribution.app.domain_name
}

output "s3_bucket_name" {
  description = "Name of the S3 bucket holding static assets (deploy pipeline syncs to this)"
  value       = aws_s3_bucket.static.bucket
}

output "s3_bucket_arn" {
  description = "ARN of the static asset S3 bucket (passed to github-actions-oidc for sync permission)"
  value       = aws_s3_bucket.static.arn
}
