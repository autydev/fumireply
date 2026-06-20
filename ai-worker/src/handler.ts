import type { SQSEvent, SQSHandler, SQSRecord } from 'aws-lambda'
import Anthropic from '@anthropic-ai/sdk'
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { dbAdmin } from './db/client'
import { withTenant } from './db/with-tenant'
import { aiDrafts, connectedPages, conversations, messages } from './db/schema'
import { getSsmParameter } from './services/ssm'
import {
  BASE_SYSTEM_PROMPT,
  LANGUAGE_DIRECTIVE,
  buildAdditionalSystemPrompt,
  buildUserPrompt,
} from './prompt'
import { processSummaryJob } from './summary'
import { RECENT_MESSAGES_CAP, UNANSWERED_CAP } from './config'

const DRAFT_BODY_SCHEMA = z.object({
  jobType: z.literal('draft').optional().default('draft'),
  conversationId: z.string().uuid(),
  triggerMessageId: z.string().uuid().optional(),
})

// Legacy { messageId } jobs enqueued before the conversation-scoped migration.
const LEGACY_DRAFT_BODY_SCHEMA = z.object({
  messageId: z.string().uuid(),
})

const SUMMARY_BODY_SCHEMA = z.object({
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

// Marks the conversation's active (pending) draft as dismissed — used when there
// is nothing to answer (the unanswered batch is empty).
async function dismissActiveDraft(tenantId: string, conversationId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(aiDrafts)
      .set({ status: 'dismissed', updatedAt: new Date() })
      .where(
        and(
          eq(aiDrafts.conversationId, conversationId),
          inArray(aiDrafts.status, ['pending', 'ready']),
        ),
      )
  })
}

async function processDraftJob(input: {
  conversationId: string
  triggerMessageId?: string
}): Promise<void> {
  const { conversationId, triggerMessageId } = input

  // 1. Resolve tenant_id with service role (bypasses RLS)
  const rows = await dbAdmin
    .select({ tenantId: conversations.tenantId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))

  if (rows.length === 0) {
    console.info({ event: 'conversation_not_found', conversationId })
    return
  }

  const { tenantId } = rows[0]

  // 2. Read coalesce state + settings + unanswered batch + context in one RLS tx
  type Outcome = 'generate' | 'superseded' | 'no_unanswered'
  // Cast keeps the union type so reassignments inside the tx callback below are
  // not narrowed away by control-flow analysis.
  let outcome: Outcome = 'no_unanswered' as Outcome
  let history: HistoryItem[] = []
  let unanswered: Array<{ body: string }> = []
  let pagePrompt: string | null = null
  let tonePreset: string | null = null
  let customerPrompt: string | null = null
  let summary: string | null = null

  await withTenant(tenantId, async (tx) => {
    // Coalesce: only the job triggered by the latest inbound text message generates.
    // Earlier jobs in a burst skip — the last one produces the final batch draft.
    const [latestInbound] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.direction, 'inbound'),
          eq(messages.messageType, 'text'),
        ),
      )
      .orderBy(desc(messages.timestamp), desc(messages.id))
      .limit(1)

    if (!latestInbound) {
      outcome = 'no_unanswered'
      return
    }

    if (triggerMessageId && latestInbound.id !== triggerMessageId) {
      outcome = 'superseded'
      return
    }

    // Conversation settings + page custom_prompt
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
        .where(eq(conversations.id, conversationId))

      convoSettings = convo ?? null
    } catch (err) {
      console.error({
        event: 'draft_settings_fetch_failed',
        tenantId,
        conversationId,
        error: String(err),
      })
      // Fail-open: continue with all null settings
    }

    pagePrompt = convoSettings?.pageCustomPrompt ?? null
    tonePreset = convoSettings?.tonePreset ?? null
    customerPrompt = convoSettings?.customPrompt ?? null
    summary = convoSettings?.summary ?? null

    // Unanswered batch boundary = last outbound message timestamp.
    const [lastOut] = await tx
      .select({ ts: sql<Date | null>`max(${messages.timestamp})` })
      .from(messages)
      .where(
        and(eq(messages.conversationId, conversationId), eq(messages.direction, 'outbound')),
      )
    const lastOutboundTs = lastOut?.ts ?? new Date(0)

    const unansweredRows = await tx
      .select({ body: messages.body })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.direction, 'inbound'),
          eq(messages.messageType, 'text'),
          gt(messages.timestamp, lastOutboundTs),
        ),
      )
      .orderBy(asc(messages.timestamp))
      .limit(UNANSWERED_CAP)

    if (unansweredRows.length === 0) {
      outcome = 'no_unanswered'
      return
    }
    unanswered = unansweredRows

    // Context window (003): text history after the summary cursor.
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
          eq(messages.conversationId, conversationId),
          eq(messages.messageType, 'text'),
          gt(messages.timestamp, cursor),
        ),
      )
      .orderBy(desc(messages.timestamp))
      .limit(RECENT_MESSAGES_CAP)

    history = historyDesc.reverse()
    outcome = 'generate'
  })

  if (outcome === 'superseded') {
    console.info({ event: 'draft_superseded', conversationId, triggerMessageId })
    return
  }

  if (outcome === 'no_unanswered') {
    await dismissActiveDraft(tenantId, conversationId)
    console.info({ event: 'draft_no_unanswered', conversationId })
    return
  }

  // 3. Build system prompt blocks (unchanged from 003)
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
  systemBlocks.push({ type: 'text', text: LANGUAGE_DIRECTIVE })

  const _pp = pagePrompt as string | null
  const _cp = customerPrompt as string | null
  const _sm = summary as string | null
  console.info({
    event: 'draft_batch_composed',
    tenantId,
    conversationId,
    page_prompt_present: _pp != null && _pp.trim() !== '',
    tone_present: tonePreset !== null,
    customer_prompt_present: _cp != null && _cp.trim() !== '',
    summary_present: _sm != null && _sm.trim() !== '',
    unanswered_count: unanswered.length,
    history_count: history.length,
  })

  // 4. Call Anthropic OUTSIDE any DB transaction — no connection held during API latency
  const userPrompt = buildUserPrompt(history, unanswered)
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

    console.error({ event: 'anthropic_error', conversationId, status, error })
    update = { status: 'failed', error }
  }

  const latencyMs = Date.now() - startMs

  // 5. Write result to the conversation's active draft. Target both 'pending' and
  // 'ready' so a regeneration (a later coalesced job) is not lost when an earlier
  // job already flipped the row to 'ready' during this job's generation window.
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(aiDrafts)
      .set({ ...update, latencyMs, updatedAt: new Date() })
      .where(
        and(
          eq(aiDrafts.conversationId, conversationId),
          inArray(aiDrafts.status, ['pending', 'ready']),
        ),
      )
  })

  console.info({ event: 'draft_persisted', conversationId, status: update.status, latencyMs })
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

  // Draft job (conversation-scoped)
  const draftResult = DRAFT_BODY_SCHEMA.safeParse(parsed)
  if (draftResult.success) {
    await processDraftJob({
      conversationId: draftResult.data.conversationId,
      triggerMessageId: draftResult.data.triggerMessageId,
    })
    return
  }

  // Legacy { messageId } jobs in-flight from before the conversation-scoped migration:
  // resolve the conversation and treat the message as the trigger.
  const legacy = LEGACY_DRAFT_BODY_SCHEMA.safeParse(parsed)
  if (legacy.success) {
    const [row] = await dbAdmin
      .select({ conversationId: messages.conversationId })
      .from(messages)
      .where(eq(messages.id, legacy.data.messageId))
    if (!row) {
      console.info({ event: 'message_not_found', messageId: legacy.data.messageId })
      return
    }
    await processDraftJob({
      conversationId: row.conversationId,
      triggerMessageId: legacy.data.messageId,
    })
    return
  }

  console.error({ event: 'sqs_parse_error', rawBody: record.body })
}

export const handler: SQSHandler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    await processRecord(record)
  }
}

