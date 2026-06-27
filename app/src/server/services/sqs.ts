import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { env } from '~/server/env'

let cachedClient: SQSClient | null = null

function getClient(): SQSClient {
  if (cachedClient) return cachedClient
  cachedClient = new SQSClient({ region: env.AWS_REGION })
  return cachedClient
}

function requireQueueUrl(): string {
  const url = env.SQS_QUEUE_URL
  if (!url) {
    throw new Error(
      'SQS_QUEUE_URL is not configured. Set it to the draft queue URL (same value as webhook).',
    )
  }
  return url
}

export type EnqueueDraftJobInput = {
  conversationId: string
  triggerType: 'regenerate'
  instruction?: string
}

export async function enqueueDraftJob(input: EnqueueDraftJobInput): Promise<void> {
  const { conversationId, triggerType, instruction } = input

  const body: Record<string, unknown> = {
    jobType: 'draft',
    conversationId,
    triggerType,
  }

  const trimmed = instruction?.trim()
  if (trimmed) {
    body.instruction = trimmed
  }

  await getClient().send(
    new SendMessageCommand({
      QueueUrl: requireQueueUrl(),
      DelaySeconds: 0,
      MessageBody: JSON.stringify(body),
    }),
  )
}
