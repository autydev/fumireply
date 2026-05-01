output "lambda_function_arn" {
  description = "ARN of the webhook Lambda function"
  value       = aws_lambda_function.webhook.arn
}

output "lambda_function_name" {
  description = "Name of the webhook Lambda function"
  value       = aws_lambda_function.webhook.function_name
}
