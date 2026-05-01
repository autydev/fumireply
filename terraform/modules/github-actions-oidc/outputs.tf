output "role_arn" {
  description = "ARN of the IAM role assumed by GitHub Actions workflows"
  value       = aws_iam_role.github_actions.arn
}
