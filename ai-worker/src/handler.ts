import type { SQSEvent, SQSHandler } from 'aws-lambda'
import Anthropic from '@anthropic-ai/sdk'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { dbAdmin } from './db/client'
import { withTenant } from './db/with-tenant'
import { aiDrafts, messages } from './db/schema'
import { getSsmParameter } from './services/ssm'
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt'

const SQS_BODY_SCHEMA = z.object({
  messageId: z.string().uuid(),
})

const ANTHROPIC_API_KEY_SSM =
  process.env.ANTHROPIC_API_KEY_SSM_KEY ?? '/fumireply/review/anthropic/api-key'
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001'
const HISTORY_LIMIT = 5
const RETRY_DELAYS_MS = [1000, 3000, 9000]

interface ApiError {
  status?: number
  message?: string
}

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
      const error = err as ApiError
      const status = error.status

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

export const handler: SQSHandler = async (event: SQSEvent) => {
  const record = event.Records[0]
  if (!record) return

  let messageId: string
  try {
    const parsed = SQS_BODY_SCHEMA.parse(JSON.parse(record.body))
    messageId = parsed.messageId
  } catch {
    console.error({ event: 'sqs_parse_error', rawBody: record.body })
    return
  }

  // Resolve tenant_id with service role (bypasses RLS)
  const rows = await dbAdmin
    .select({ tenantId: messages.tenantId })
    .from(messages)
    .where(eq(messages.id, messageId))

  if (rows.length === 0) {
    console.info({ event: 'message_not_found', messageId })
    return
  }

  const { tenantId } = rows[0]

  await withTenant(tenantId, async (tx) => {
    // Get message details within RLS context
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
      return
    }

    // Get recent conversation history (last 5, chronological)
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

    const history = historyDesc.reverse()
    const userPrompt = buildUserPrompt(history)

    const apiKey = await getSsmParameter(ANTHROPIC_API_KEY_SSM)
    const anthropic = new Anthropic({ apiKey })

    const startMs = Date.now()

    try {
      const response = await callAnthropicWithRetry(anthropic, userPrompt)
      const latencyMs = Date.now() - startMs

      const draftBody = response.content[0]?.type === 'text' ? response.content[0].text : ''
      const usage = response.usage as Anthropic.Usage & {
        cache_creation_input_tokens?: number
        cache_read_input_tokens?: number
      }
      const promptTokens =
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0)

      await tx
        .update(aiDrafts)
        .set({
          status: 'ready',
          body: draftBody,
          model: response.model,
          promptTokens,
          completionTokens: usage.output_tokens,
          latencyMs,
          updatedAt: new Date(),
        })
        .where(eq(aiDrafts.messageId, messageId))
    } catch (err) {
      const error = err as ApiError
      const latencyMs = Date.now() - startMs

      let errorCode = 'unknown_error'
      if (error.status === 401) {
        errorCode = 'auth_failed'
      } else if (error.status === 400) {
        errorCode = 'bad_request'
      } else if (error.status === 429 || (error.status !== undefined && error.status >= 500)) {
        errorCode = 'server_error'
      }

      console.error({ event: 'anthropic_error', messageId, status: error.status, error: errorCode })

      await tx
        .update(aiDrafts)
        .set({
          status: 'failed',
          error: errorCode,
          latencyMs,
          updatedAt: new Date(),
        })
        .where(eq(aiDrafts.messageId, messageId))
    }
  })
}
