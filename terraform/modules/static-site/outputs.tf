output "cloudfront_distribution_id" {
  description = "ID of the CloudFront distribution (used for cache invalidation in deploy pipeline)"
  value       = aws_cloudfront_distribution.app.id
}

output "cloudfront_domain_name" {
  description = "Domain name of the CloudFront distribution"
  value       = aws_cloudfront_distribution.app.domain_name
}

output "s3_bucket_name" {
  description = "Name of the S3 bucket holding static assets (deploy pipeline syncs to this)"
  value       = aws_s3_bucket.static.bucket
}
