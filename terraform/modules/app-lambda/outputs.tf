output "api_gateway_invoke_url" {
  description = "Invoke URL of the HTTP API (used as CloudFront dynamic origin)"
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "api_gateway_id" {
  description = "ID of the HTTP API (passed to webhook-lambda module for route injection)"
  value       = aws_apigatewayv2_api.app.id
}

output "api_gateway_execution_arn" {
  description = "Execution ARN of the HTTP API (passed to webhook-lambda for cross-module Lambda permission)"
  value       = aws_apigatewayv2_api.app.execution_arn
}

output "lambda_function_arn" {
  description = "ARN of the app Lambda function"
  value       = aws_lambda_function.app.arn
}

output "lambda_function_name" {
  description = "Name of the app Lambda function"
  value       = aws_lambda_function.app.function_name
}
