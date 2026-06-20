import { createServerFn } from '@tanstack/react-start'
import { notFound } from '@tanstack/react-router'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { aiDrafts, conversations, messages } from '~/server/db/schema'
import { withTenant } from '~/server/db/with-tenant'

const inputSchema = z.object({ id: z.string().uuid() })

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

export type MessageWithDraft = {
  id: string
  direction: 'inbound' | 'outbound'
  body: string
  message_type: 'text' | 'sticker' | 'image' | 'other'
  timestamp: string
  send_status: 'sent' | 'failed' | 'pending' | null
  send_error: string | null
  ai_draft: {
    status: 'pending' | 'ready' | 'failed'
    body: string | null
    model: string | null
  } | null
}

export type ConversationDetail = {
  conversation: {
    id: string
    customer_psid: string
    customer_name: string | null
    last_inbound_at: string | null
    within_24h_window: boolean
    hours_remaining_in_window: number | null
    summary: string | null
    last_summarized_at: string | null
    tone_preset: 'friendly' | 'professional' | 'concise' | null
    custom_prompt: string | null
    note: string | null
  }
  messages: MessageWithDraft[]
  latest_draft: {
    body: string
    status: 'pending' | 'ready' | 'failed'
  } | null
}

export const getConversationFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(inputSchema)
  .handler(async ({ data, context }) => {
    const tenantId = context.user.tenantId

    return withTenant(tenantId, async (tx) => {
      const convRows = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, data.id))
        .limit(1)

      const conv = convRows[0]
      if (!conv) {
        throw notFound()
      }

      // Reset unread_count atomically within the same transaction (RLS active)
      await tx
        .update(conversations)
        .set({ unreadCount: 0 })
        .where(eq(conversations.id, data.id))

      const msgRows = await tx
        .select({
          id: messages.id,
          direction: messages.direction,
          body: messages.body,
          messageType: messages.messageType,
          timestamp: messages.timestamp,
          sendStatus: messages.sendStatus,
          sendError: messages.sendError,
        })
        .from(messages)
        .where(eq(messages.conversationId, data.id))
        .orderBy(asc(messages.timestamp))

      // Conversation-scoped active draft (at most one pending/ready row).
      const activeDraftRows = await tx
        .select({ status: aiDrafts.status, body: aiDrafts.body })
        .from(aiDrafts)
        .where(
          and(
            eq(aiDrafts.conversationId, data.id),
            inArray(aiDrafts.status, ['pending', 'ready']),
          ),
        )
        .orderBy(desc(aiDrafts.createdAt))
        .limit(1)

      const now = Date.now()
      const lastInboundAt = conv.lastInboundAt
      const within24h = lastInboundAt
        ? now - new Date(lastInboundAt).getTime() < TWENTY_FOUR_HOURS_MS
        : false

      let hoursRemaining: number | null = null
      if (lastInboundAt && within24h) {
        const msRemaining =
          TWENTY_FOUR_HOURS_MS - (now - new Date(lastInboundAt).getTime())
        hoursRemaining = Math.max(0, msRemaining / (60 * 60 * 1000))
      }

      const mappedMessages: MessageWithDraft[] = msgRows.map((row) => ({
        id: row.id,
        direction: row.direction as 'inbound' | 'outbound',
        body: row.body,
        message_type: (row.messageType as MessageWithDraft['message_type']) ?? 'other',
        timestamp: row.timestamp.toISOString(),
        send_status: (row.sendStatus as MessageWithDraft['send_status']) ?? null,
        send_error: row.sendError ?? null,
        ai_draft: null,
      }))

      // latest_draft: the conversation's active (pending/ready) draft.
      let latestDraft: ConversationDetail['latest_draft'] = null
      const activeDraft = activeDraftRows[0]
      if (activeDraft) {
        const status: 'pending' | 'ready' | 'failed' =
          activeDraft.status === 'ready' || activeDraft.status === 'failed'
            ? activeDraft.status
            : 'pending'
        latestDraft = { body: activeDraft.body ?? '', status }
      }

      return {
        conversation: {
          id: conv.id,
          customer_psid: conv.customerPsid,
          customer_name: conv.customerName ?? null,
          last_inbound_at: lastInboundAt?.toISOString() ?? null,
          within_24h_window: within24h,
          hours_remaining_in_window: hoursRemaining,
          summary: conv.summary ?? null,
          last_summarized_at: conv.lastSummarizedAt?.toISOString() ?? null,
          tone_preset: (conv.tonePreset as 'friendly' | 'professional' | 'concise' | null) ?? null,
          custom_prompt: conv.customPrompt ?? null,
          note: conv.note ?? null,
        },
        messages: mappedMessages,
        latest_draft: latestDraft,
      } satisfies ConversationDetail
    })
  })
