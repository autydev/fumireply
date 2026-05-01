output "sns_topic_arn" {
  description = "ARN of the alert SNS topic (referenced by keep-alive-lambda and alarms)"
  value       = aws_sns_topic.alerts.arn
}
