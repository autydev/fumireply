###############################################################################
# Module: observability
#
# SNS alert topic + CloudWatch alarms for all four Lambda functions.
# Alarms defined here:
#   (a) app-lambda      Error rate > 1%
#   (b) webhook-lambda  Error rate > 0.5%
#   (c) ai-worker       DLQ ApproximateNumberOfMessagesVisible > 0
#   (d) ai-worker       Duration p95 > 30 s
#   (e) keep-alive      Errors >= 1  (DataPointsToAlarm=1, immediate)
#   (f) keep-alive      Invocations < 1 in 36 h  (execution gap detection)
###############################################################################

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

###############################################################################
# SNS Topic + email subscription
###############################################################################

resource "aws_sns_topic" "alerts" {
  name = "${var.name_prefix}-alerts"
  tags = var.tags
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

###############################################################################
# (a) app-lambda: Error rate > 1%
###############################################################################

resource "aws_cloudwatch_metric_alarm" "app_lambda_errors" {
  alarm_name          = "${var.name_prefix}-app-lambda-error-rate"
  alarm_description   = "app-lambda error rate exceeded 1%"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 1
  evaluation_periods  = 1
  datapoints_to_alarm = 1

  metric_query {
    id          = "error_rate"
    expression  = "100 * errors / MAX([errors, invocations])"
    label       = "Error Rate (%)"
    return_data = true
  }

  metric_query {
    id = "errors"
    metric {
      metric_name = "Errors"
      namespace   = "AWS/Lambda"
      period      = 300
      stat        = "Sum"
      dimensions = {
        FunctionName = var.app_lambda_function_name
      }
    }
  }

  metric_query {
    id = "invocations"
    metric {
      metric_name = "Invocations"
      namespace   = "AWS/Lambda"
      period      = 300
      stat        = "Sum"
      dimensions = {
        FunctionName = var.app_lambda_function_name
      }
    }
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
  tags          = var.tags
}

###############################################################################
# (b) webhook-lambda: Error rate > 0.5%
###############################################################################

resource "aws_cloudwatch_metric_alarm" "webhook_lambda_errors" {
  alarm_name          = "${var.name_prefix}-webhook-lambda-error-rate"
  alarm_description   = "webhook-lambda error rate exceeded 0.5%"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0.5
  evaluation_periods  = 1
  datapoints_to_alarm = 1

  metric_query {
    id          = "error_rate"
    expression  = "100 * errors / MAX([errors, invocations])"
    label       = "Error Rate (%)"
    return_data = true
  }

  metric_query {
    id = "errors"
    metric {
      metric_name = "Errors"
      namespace   = "AWS/Lambda"
      period      = 300
      stat        = "Sum"
      dimensions = {
        FunctionName = var.webhook_lambda_function_name
      }
    }
  }

  metric_query {
    id = "invocations"
    metric {
      metric_name = "Invocations"
      namespace   = "AWS/Lambda"
      period      = 300
      stat        = "Sum"
      dimensions = {
        FunctionName = var.webhook_lambda_function_name
      }
    }
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
  tags          = var.tags
}

###############################################################################
# (c) ai-worker DLQ: messages visible > 0
###############################################################################

resource "aws_cloudwatch_metric_alarm" "ai_worker_dlq" {
  alarm_name          = "${var.name_prefix}-ai-worker-dlq-not-empty"
  alarm_description   = "AI worker DLQ has messages — processing failures need investigation"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  period              = 300
  statistic           = "Maximum"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = element(split(":", var.ai_draft_dlq_arn), length(split(":", var.ai_draft_dlq_arn)) - 1)
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
  tags          = var.tags
}

###############################################################################
# (d) ai-worker Duration: p95 > 30 s
###############################################################################

resource "aws_cloudwatch_metric_alarm" "ai_worker_duration" {
  alarm_name          = "${var.name_prefix}-ai-worker-duration-p95"
  alarm_description   = "AI worker p95 duration exceeded 30 s"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 30000 # milliseconds
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  namespace           = "AWS/Lambda"
  metric_name         = "Duration"
  period              = 300
  extended_statistic  = "p95"

  dimensions = {
    FunctionName = var.ai_worker_lambda_function_name
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
  tags          = var.tags
}

###############################################################################
# (e) keep-alive Errors >= 1 (immediate, DataPointsToAlarm=1)
###############################################################################

resource "aws_cloudwatch_metric_alarm" "keep_alive_errors" {
  alarm_name          = "${var.name_prefix}-keep-alive-errors"
  alarm_description   = "keep-alive Lambda failed — Supabase may be paused"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  period              = 3600
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = var.keep_alive_lambda_function_name
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
  tags          = var.tags
}

###############################################################################
# (f) keep-alive Invocations < 1 in 36 h (execution gap detection)
###############################################################################

resource "aws_cloudwatch_metric_alarm" "keep_alive_not_invoked" {
  alarm_name          = "${var.name_prefix}-keep-alive-not-invoked"
  alarm_description   = "keep-alive Lambda has not been invoked in 36 hours — EventBridge schedule may be broken"
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  evaluation_periods  = 3 # 3 × 43200s = 36 h window
  datapoints_to_alarm = 3
  namespace           = "AWS/Lambda"
  metric_name         = "Invocations"
  period              = 43200 # 12 hours
  statistic           = "Sum"
  treat_missing_data  = "breaching"

  dimensions = {
    FunctionName = var.keep_alive_lambda_function_name
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
  tags          = var.tags
}
