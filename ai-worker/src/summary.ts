import Anthropic from '@anthropic-ai/sdk'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { dbAdmin } from './db/client'
import { withTenant } from './db/with-tenant'
import { conversations, messages } from './db/schema'
import { getSsmParameter } from './services/ssm'
import { buildSummaryPrompt } from './prompt'
import { SUMMARY_MAX_INPUT_MESSAGES, SUMMARY_TRIGGER_THRESHOLD_CHARS } from './config'

const SUMMARY_JOB_SCHEMA = z.object({
  jobType: z.literal('summary'),
  conversationId: z.string().uuid(),
  enqueuedAt: z.string().optional(),
})

const ANTHROPIC_API_KEY_SSM =
  process.env.ANTHROPIC_API_KEY_SSM_KEY ?? '/fumireply/review/anthropic/api-key'
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001'
const ANTHROPIC_TIMEOUT_MS = 30_000
const RETRY_DELAYS_MS = [1000, 3000, 9000]

interface ApiError {
  status?: number
}

async function callAnthropicForSummary(
  client: Anthropic,
  system: string,
  user: string,
): Promise<string> {
  let lastError: unknown = null

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const response = await client.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 600,
        system,
        messages: [{ role: 'user', content: user }],
      })
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
      return text
    } catch (err) {
      const status = (err as ApiError).status
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

export async function processSummaryJob(body: unknown): Promise<void> {
  if (process.env.SUMMARY_PIPELINE_ENABLED === 'false') {
    console.info({ event: 'summary_pipeline_disabled' })
    return
  }

  const parsed = SUMMARY_JOB_SCHEMA.safeParse(body)
  if (!parsed.success) {
    console.error({ event: 'summary_job_parse_error', error: parsed.error.message, body })
    return
  }

  const { conversationId } = parsed.data

  // Resolve tenant via service role (bypasses RLS)
  const rows = await dbAdmin
    .select({ tenantId: conversations.tenantId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))

  if (rows.length === 0) {
    console.info({ event: 'conversation_not_found', conversationId })
    return
  }

  const { tenantId } = rows[0]

  // Threshold re-evaluation (idempotency: R-006)
  let existingSummary: string | null = null
  let msgsForSummary: Array<{ direction: string; body: string; timestamp: Date }> = []
  let lastMsgTimestamp: Date | null = null

  await withTenant(tenantId, async (tx) => {
    const [convo] = await tx
      .select({ summary: conversations.summary, lastSummarizedAt: conversations.lastSummarizedAt })
      .from(conversations)
      .where(eq(conversations.id, conversationId))

    existingSummary = convo?.summary ?? null
    const cursor = convo?.lastSummarizedAt ?? new Date(0)

    const msgs = await tx
      .select({ direction: messages.direction, body: messages.body, timestamp: messages.timestamp })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.messageType, 'text'),
          gt(messages.timestamp, cursor),
        ),
      )
      .orderBy(asc(messages.timestamp))
      .limit(SUMMARY_MAX_INPUT_MESSAGES)

    const totalChars = msgs.reduce((sum, m) => sum + m.body.length, 0)
    if (totalChars < SUMMARY_TRIGGER_THRESHOLD_CHARS) {
      console.info({
        event: 'summary_skipped_below_threshold',
        tenantId,
        conversationId,
        totalChars,
      })
      msgsForSummary = []
      return
    }

    msgsForSummary = msgs
    lastMsgTimestamp = msgs.length > 0 ? msgs[msgs.length - 1].timestamp : null
  })

  if (msgsForSummary.length === 0 || !lastMsgTimestamp) return

  console.info({
    event: 'summary_started',
    tenantId,
    conversationId,
    messages_in_summary: msgsForSummary.length,
  })

  const { system, user } = buildSummaryPrompt(existingSummary, msgsForSummary)

  const apiKey = await getSsmParameter(ANTHROPIC_API_KEY_SSM)
  const anthropic = new Anthropic({ apiKey, timeout: ANTHROPIC_TIMEOUT_MS, maxRetries: 0 })

  const startMs = Date.now()
  let summaryText: string

  try {
    summaryText = await callAnthropicForSummary(anthropic, system, user)
  } catch (err) {
    console.error({ event: 'summary_failed', tenantId, conversationId, error: String(err) })
    throw err
  }

  const latencyMs = Date.now() - startMs
  const finalLastMsgTimestamp = lastMsgTimestamp as Date

  await withTenant(tenantId, async (tx) => {
    await tx
      .update(conversations)
      .set({
        summary: summaryText,
        lastSummarizedAt: finalLastMsgTimestamp,
      })
      .where(eq(conversations.id, conversationId))
  })

  console.info({
    event: 'summary_completed',
    tenantId,
    conversationId,
    latency_ms: latencyMs,
  })
}
