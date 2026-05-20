import type { SQSEvent, SQSHandler, SQSRecord } from 'aws-lambda'
import Anthropic from '@anthropic-ai/sdk'
import { and, desc, eq, gt } from 'drizzle-orm'
import { z } from 'zod'
import { dbAdmin } from './db/client'
import { withTenant } from './db/with-tenant'
import { aiDrafts, connectedPages, conversations, messages } from './db/schema'
import { getSsmParameter } from './services/ssm'
import { BASE_SYSTEM_PROMPT, buildAdditionalSystemPrompt, buildUserPrompt } from './prompt'
import { RECENT_MESSAGES_CAP } from './config'

const DRAFT_BODY_SCHEMA = z.object({
  jobType: z.literal('draft').optional().default('draft'),
  messageId: z.string().uuid(),
})

const SUMMARY_BODY_SCHEMA = z.object({
  jobType: z.literal('summary'),
  conversationId: z.string().uuid(),
  enqueuedAt: z.string().optional(),
})

const SQS_BODY_SCHEMA = z.union([DRAFT_BODY_SCHEMA, SUMMARY_BODY_SCHEMA]).or(
  z.object({ messageId: z.string().uuid() }),
)

const ANTHROPIC_API_KEY_SSM =
  process.env.ANTHROPIC_API_KEY_SSM_KEY ?? '/fumireply/review/anthropic/api-key'
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001'
const ANTHROPIC_TIMEOUT_MS = 30_000
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
  systemBlocks: Anthropic.TextBlockParam[],
): Promise<Anthropic.Message> {
  let lastError: unknown = null

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await client.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 300,
        system: systemBlocks,
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

async function processDraftJob(messageId: string): Promise<void> {
  // 1. Resolve tenant_id with service role (bypasses RLS)
  const rows = await dbAdmin
    .select({ tenantId: messages.tenantId })
    .from(messages)
    .where(eq(messages.id, messageId))

  if (rows.length === 0) {
    console.info({ event: 'message_not_found', messageId })
    return
  }

  const { tenantId } = rows[0]

  // 2. Read message + conversation settings + history in a single RLS transaction
  let history: HistoryItem[] = []
  let skipped = false
  let pagePrompt: string | null = null
  let tonePreset: string | null = null
  let customerPrompt: string | null = null
  let summary: string | null = null
  let conversationId: string | null = null

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

    conversationId = msg.conversationId

    // Fetch conversation settings + page custom_prompt in one join
    let convoSettings: {
      summary: string | null
      lastSummarizedAt: Date | null
      tonePreset: string | null
      customPrompt: string | null
      pageCustomPrompt: string | null
    } | null = null

    try {
      const [convo] = await tx
        .select({
          summary: conversations.summary,
          lastSummarizedAt: conversations.lastSummarizedAt,
          tonePreset: conversations.tonePreset,
          customPrompt: conversations.customPrompt,
          pageCustomPrompt: connectedPages.customPrompt,
        })
        .from(conversations)
        .leftJoin(connectedPages, eq(conversations.pageId, connectedPages.id))
        .where(eq(conversations.id, msg.conversationId))

      convoSettings = convo ?? null
    } catch (err) {
      console.error({
        event: 'draft_settings_fetch_failed',
        tenantId,
        conversationId: msg.conversationId,
        error: String(err),
      })
      // Fail-open: continue with all null settings
    }

    pagePrompt = convoSettings?.pageCustomPrompt ?? null
    tonePreset = convoSettings?.tonePreset ?? null
    customerPrompt = convoSettings?.customPrompt ?? null
    summary = convoSettings?.summary ?? null

    const cursor = convoSettings?.lastSummarizedAt ?? new Date(0)

    const historyDesc = await tx
      .select({
        direction: messages.direction,
        body: messages.body,
        messageType: messages.messageType,
      })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, msg.conversationId),
          eq(messages.messageType, 'text'),
          gt(messages.timestamp, cursor),
        ),
      )
      .orderBy(desc(messages.timestamp))
      .limit(RECENT_MESSAGES_CAP)

    history = historyDesc.reverse()
  })

  if (skipped) return

  // 3. Build system prompt blocks
  const additionalText = buildAdditionalSystemPrompt({
    pagePrompt,
    tonePreset: tonePreset as 'friendly' | 'professional' | 'concise' | null,
    customerPrompt,
    summary,
  })

  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: 'text', text: BASE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ]
  if (additionalText) {
    systemBlocks.push({ type: 'text', text: additionalText })
  }

  console.info({
    event: 'draft_prompt_composed',
    tenantId,
    conversationId,
    page_prompt_present: pagePrompt !== null,
    tone_present: tonePreset !== null,
    customer_prompt_present: customerPrompt !== null,
    summary_present: summary !== null,
    messages_count: history.length,
  })

  // 4. Call Anthropic OUTSIDE any DB transaction — no connection held during API latency
  const userPrompt = buildUserPrompt(history)
  const apiKey = await getSsmParameter(ANTHROPIC_API_KEY_SSM)
  const anthropic = new Anthropic({ apiKey, timeout: ANTHROPIC_TIMEOUT_MS, maxRetries: 0 })

  const startMs = Date.now()
  let update: AiDraftUpdate

  try {
    const response = await callAnthropicWithRetry(anthropic, userPrompt, systemBlocks)

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

async function processSummaryJob(body: unknown): Promise<void> {
  // Stub: will be implemented in U4.1. Logs and returns to avoid DLQ flooding.
  console.info({ event: 'summary_skipped_not_yet_implemented', body })
}

async function processRecord(record: SQSRecord): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(record.body)
  } catch {
    console.error({ event: 'sqs_parse_error', rawBody: record.body })
    return
  }

  // Dispatch on jobType (default 'draft' for backward compat)
  const jobType =
    parsed !== null && typeof parsed === 'object' && 'jobType' in parsed
      ? (parsed as { jobType?: string }).jobType
      : 'draft'

  if (jobType === 'summary') {
    await processSummaryJob(parsed)
    return
  }

  // Draft job (default path)
  const draftResult = DRAFT_BODY_SCHEMA.safeParse(parsed)
  if (!draftResult.success) {
    // Try legacy format: { messageId }
    const legacy = z.object({ messageId: z.string().uuid() }).safeParse(parsed)
    if (!legacy.success) {
      console.error({ event: 'sqs_parse_error', rawBody: record.body })
      return
    }
    await processDraftJob(legacy.data.messageId)
    return
  }

  await processDraftJob(draftResult.data.messageId)
}

export const handler: SQSHandler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    await processRecord(record)
  }
}

