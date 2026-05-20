import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { and, eq, gt, sql } from 'drizzle-orm'
import { conversations, messages } from '~/server/db/schema'
import { withTenant } from '~/server/db/with-tenant'

const sqsClient = new SQSClient({ region: process.env.AWS_REGION ?? 'ap-northeast-1' })

function getThreshold(): number {
  const v = parseInt(process.env.SUMMARY_TRIGGER_THRESHOLD_CHARS ?? '2000', 10)
  return Number.isFinite(v) ? v : 2000
}

function isPipelineEnabled(): boolean {
  return process.env.SUMMARY_PIPELINE_ENABLED !== 'false'
}

export async function maybeEnqueueSummaryJob(
  conversationId: string,
  tenantId: string,
): Promise<void> {
  const queueUrl = process.env.AI_SUMMARY_QUEUE_URL
  if (!queueUrl || !isPipelineEnabled()) {
    console.info({ event: 'summary_enqueue_skipped_disabled', conversationId })
    return
  }

  let shouldEnqueue = false
  await withTenant(tenantId, async (tx) => {
    const [convo] = await tx
      .select({ lastSummarizedAt: conversations.lastSummarizedAt })
      .from(conversations)
      .where(eq(conversations.id, conversationId))

    const cursor = convo?.lastSummarizedAt ?? new Date(0)

    const [result] = await tx
      .select({
        totalChars: sql<string>`COALESCE(SUM(char_length(${messages.body})), 0)`,
      })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.messageType, 'text'),
          gt(messages.timestamp, cursor),
        ),
      )

    shouldEnqueue = parseInt(result?.totalChars ?? '0', 10) >= getThreshold()
  })

  if (!shouldEnqueue) {
    console.info({ event: 'summary_enqueue_skipped_below_threshold', conversationId })
    return
  }

  try {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          jobType: 'summary',
          conversationId,
          enqueuedAt: new Date().toISOString(),
        }),
      }),
    )
    console.info({ event: 'summary_enqueued', conversationId })
  } catch (err) {
    console.warn({ event: 'summary_enqueue_failed', conversationId, error: String(err) })
  }
}
