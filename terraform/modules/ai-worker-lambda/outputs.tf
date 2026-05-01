output "lambda_function_arn" {
  description = "ARN of the AI worker Lambda function"
  value       = aws_lambda_function.ai_worker.arn
}

output "lambda_function_name" {
  description = "Name of the AI worker Lambda function"
  value       = aws_lambda_function.ai_worker.function_name
}
