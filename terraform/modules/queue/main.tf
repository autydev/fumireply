###############################################################################
# Module: queue
#
# SQS Standard Queue for AI draft generation + Dead Letter Queue.
# Messages carry only { messageId } — no PII in queue payload.
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

resource "aws_sqs_queue" "ai_draft_dlq" {
  name                       = "${var.name_prefix}-ai-draft-dlq"
  message_retention_seconds  = 1209600 # 14 days
  receive_wait_time_seconds  = 20

  tags = var.tags
}

resource "aws_sqs_queue" "ai_draft" {
  name                       = "${var.name_prefix}-ai-draft-queue"
  visibility_timeout_seconds = 90
  message_retention_seconds  = 345600 # 4 days
  receive_wait_time_seconds  = 20     # long polling

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.ai_draft_dlq.arn
    maxReceiveCount     = 3
  })

  tags = var.tags
}
