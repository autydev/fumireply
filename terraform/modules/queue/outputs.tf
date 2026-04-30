output "queue_url" {
  description = "URL of the AI draft SQS queue"
  value       = aws_sqs_queue.ai_draft.url
}

output "queue_arn" {
  description = "ARN of the AI draft SQS queue"
  value       = aws_sqs_queue.ai_draft.arn
}

output "dlq_arn" {
  description = "ARN of the AI draft dead-letter queue"
  value       = aws_sqs_queue.ai_draft_dlq.arn
}
