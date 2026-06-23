import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'

let cachedClient: SQSClient | null = null

function getClient(): SQSClient {
  if (cachedClient) return cachedClient
  const region = process.env.AWS_REGION
  if (!region) throw new Error('AWS_REGION environment variable is required')
  cachedClient = new SQSClient({ region })
  return cachedClient
}

/**
 * After a successful one-off regenerate (005), if newer inbound messages arrived
 * during processing the worker self-enqueues a normal auto-batch job so the
 * eventual draft still reflects the latest inbound. Failure to enqueue must not
 * fail the regenerate write — callers wrap in try/catch.
 */
export async function enqueueAutoBatchFollowup(input: {
  conversationId: string
  triggerMessageId: string
  delaySeconds: number
}): Promise<void> {
  const queueUrl = process.env.SQS_QUEUE_URL
  if (!queueUrl) {
    // Queue URL not configured (e.g., local test without SQS); skip silently.
    return
  }
  await getClient().send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      DelaySeconds: input.delaySeconds,
      MessageBody: JSON.stringify({
        jobType: 'draft',
        conversationId: input.conversationId,
        triggerMessageId: input.triggerMessageId,
      }),
    }),
  )
}
