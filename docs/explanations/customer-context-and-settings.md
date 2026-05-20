# Customer Context & Settings

Feature: 会話コンテキストの永続化と設定の階層化 (003)

## Overview

This feature adds three layers of AI draft customization:

1. **Shop policy** (`connected_pages.custom_prompt`) — operator-wide, per Facebook Page
2. **Customer AI settings** (`conversations.tone_preset` + `conversations.custom_prompt`) — per conversation
3. **Conversation summary** (`conversations.summary`) — auto-generated, updated by the summary pipeline

These are combined into the AI draft system prompt in the following order (highest specificity last):

```
[1] BASE_SYSTEM_PROMPT  (cached, ephemeral)
[2] ## Shop policy: <pagePrompt>
[3] ## Customer-specific tone: <toneLabel>
[4] ## Customer-specific instructions: <customerPrompt>
[5] ## Conversation summary: <summary>
```

The `note` field (internal operator memo) is **never** sent to the AI.

## Settings Page

Accessible at `/settings`. Displays all connected Facebook Pages for the tenant.
Each page has a textarea for "Shop policy" (max 2,000 chars) that autosaves with debounce.

## CustomerPanel

Visible in the thread view (right column at ≥1280px, toggle button on narrow viewports).
Sections:
- **AI persona** — AI-generated summary of the conversation (null = empty placeholder)
- **AI draft settings** — Tone preset + custom instructions, autosaved
- **Internal note** — Free-text memo, autosaved, not sent to AI

## Summary Pipeline

The summary pipeline runs as a background job when the accumulated message char count since the last summary exceeds `SUMMARY_TRIGGER_THRESHOLD_CHARS` (default: 2000).

### Trigger points

- **Inbound message** (webhook Lambda): fires regardless of draft SQS success — summary tracks conversation content, not AI drafts
- **Outbound reply** (app Lambda / `sendReplyFn`): after successful send

Both paths call `maybeEnqueueSummaryJob(conversationId, tenantId)`, which:
1. Opens a `withTenant` transaction to compute `SUM(char_length(body))` for text messages since `last_summarized_at`
2. If above threshold, sends an SQS message `{ jobType: 'summary', conversationId }` to `AI_SUMMARY_QUEUE_URL`
3. SQS failures are non-fatal (logged as warning, not re-thrown)

### Summary processor (ai-worker)

`processSummaryJob` in `ai-worker/src/summary.ts`:
1. Re-evaluates threshold inside `withTenant` (idempotency: R-006)
2. Calls Anthropic Haiku 4.5 with `buildSummaryPrompt(existingSummary, messages)`
3. Updates `conversations.summary` + `conversations.last_summarized_at`

### Circuit breaker

Set `SUMMARY_PIPELINE_ENABLED=false` to disable the pipeline immediately (both trigger and processor). Useful for incident response.

### Terraform diff (from main)

- 1 new SQS queue `{prefix}-ai-summary-queue` + DLQ `{prefix}-ai-summary-dlq`
- 1 new event source mapping on ai-worker Lambda
- IAM: ai-worker gets `sqs:ReceiveMessage/DeleteMessage/GetQueueAttributes` on summary queue
- IAM: app Lambda gets `sqs:SendMessage` on summary queue
- Env vars `AI_SUMMARY_QUEUE_URL`, `SUMMARY_TRIGGER_THRESHOLD_CHARS`, `SUMMARY_PIPELINE_ENABLED` added to both ai-worker and app lambdas
