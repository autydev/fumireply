output "lambda_function_arn" {
  description = "ARN of the keep-alive Lambda function"
  value       = aws_lambda_function.keep_alive.arn
}

output "lambda_function_name" {
  description = "Name of the keep-alive Lambda function"
  value       = aws_lambda_function.keep_alive.function_name
}

output "event_rule_arn" {
  description = "ARN of the EventBridge scheduled rule"
  value       = aws_cloudwatch_event_rule.keep_alive.arn
}
