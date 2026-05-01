import type { SQSEvent, SQSHandler, SQSRecord } from 'aws-lambda'
import Anthropic from '@anthropic-ai/sdk'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { dbAdmin } from './db/client'
import { withTenant } from './db/with-tenant'
import { aiDrafts, messages } from './db/schema'
import { getSsmParameter } from './services/ssm'
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt'

const SQS_BODY_SCHEMA = z.object({
  messageId: z.string().uuid(),
})

const ANTHROPIC_API_KEY_SSM =
  process.env.ANTHROPIC_API_KEY_SSM_KEY ?? '/fumireply/review/anthropic/api-key'
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001'
const ANTHROPIC_TIMEOUT_MS = 30_000
const HISTORY_LIMIT = 5
const RETRY_DELAYS_MS = [1000, 3000, 9000]

interface ApiError {
  status?: number
}

interface HistoryItem {
  direction: string
  body: string
  messageType: string
}

type AiDraftUpdate =
  | {
      status: 'ready'
      body: string
      model: string
      promptTokens: number
      completionTokens: number
    }
  | { status: 'failed'; error: string }

async function callAnthropicWithRetry(
  client: Anthropic,
  userPrompt: string,
): Promise<Anthropic.Message> {
  let lastError: unknown = null

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await client.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 300,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: userPrompt }],
      })
    } catch (err) {
      const status = (err as ApiError).status
      // Non-retryable 4xx (except 429)
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
        throw err
      }
      lastError = err
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
      }
    }
  }

  throw lastError
}

async function processRecord(record: SQSRecord): Promise<void> {
  // 1. Parse SQS message
  let messageId: string
  try {
    const parsed = SQS_BODY_SCHEMA.parse(JSON.parse(record.body))
    messageId = parsed.messageId
  } catch {
    console.error({ event: 'sqs_parse_error', rawBody: record.body })
    return
  }

  // 2. Resolve tenant_id with service role (bypasses RLS)
  const rows = await dbAdmin
    .select({ tenantId: messages.tenantId })
    .from(messages)
    .where(eq(messages.id, messageId))

  if (rows.length === 0) {
    console.info({ event: 'message_not_found', messageId })
    return
  }

  const { tenantId } = rows[0]

  // 3. Read message + history in a short RLS transaction, then release the connection
  let history: HistoryItem[] = []
  let skipped = false

  await withTenant(tenantId, async (tx) => {
    const [msg] = await tx
      .select({
        body: messages.body,
        messageType: messages.messageType,
        conversationId: messages.conversationId,
      })
      .from(messages)
      .where(eq(messages.id, messageId))

    if (!msg || msg.messageType !== 'text') {
      console.info({ event: 'skip_non_text', messageId, messageType: msg?.messageType })
      skipped = true
      return
    }

    const historyDesc = await tx
      .select({
        direction: messages.direction,
        body: messages.body,
        messageType: messages.messageType,
      })
      .from(messages)
      .where(and(eq(messages.conversationId, msg.conversationId), eq(messages.messageType, 'text')))
      .orderBy(desc(messages.timestamp))
      .limit(HISTORY_LIMIT)

    history = historyDesc.reverse()
  })

  if (skipped) return

  // 4. Call Anthropic OUTSIDE any DB transaction — no connection held during API latency
  const userPrompt = buildUserPrompt(history)
  const apiKey = await getSsmParameter(ANTHROPIC_API_KEY_SSM)
  const anthropic = new Anthropic({ apiKey, timeout: ANTHROPIC_TIMEOUT_MS, maxRetries: 0 })

  const startMs = Date.now()
  let update: AiDraftUpdate

  try {
    const response = await callAnthropicWithRetry(anthropic, userPrompt)

    // Collect all text blocks; treat empty result as unexpected failure
    const draftBody = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')

    if (!draftBody) {
      update = { status: 'failed', error: 'unexpected_response_type' }
    } else {
      const usage = response.usage as Anthropic.Usage & {
        cache_creation_input_tokens?: number
        cache_read_input_tokens?: number
      }
      update = {
        status: 'ready',
        body: draftBody,
        model: response.model,
        promptTokens:
          (usage.input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0),
        completionTokens: usage.output_tokens,
      }
    }
  } catch (err) {
    const status = (err as ApiError).status
    let error = 'unknown_error'
    if (status === 401) error = 'auth_failed'
    else if (status === 400) error = 'bad_request'
    else if (status === 429 || (status !== undefined && status >= 500)) error = 'server_error'

    console.error({ event: 'anthropic_error', messageId, status, error })
    update = { status: 'failed', error }
  }

  const latencyMs = Date.now() - startMs

  // 5. Write ai_drafts result in a separate transaction
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(aiDrafts)
      .set({ ...update, latencyMs, updatedAt: new Date() })
      .where(eq(aiDrafts.messageId, messageId))
  })
}

export const handler: SQSHandler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    await processRecord(record)
  }
}
