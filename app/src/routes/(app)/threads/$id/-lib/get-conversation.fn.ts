import { createServerFn } from '@tanstack/react-start'
import { notFound } from '@tanstack/react-router'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { aiDrafts, conversations, messages } from '~/server/db/schema'
import { withTenant, type TenantTx } from '~/server/db/with-tenant'
import { getAttachmentUrl } from '~/server/services/media-url'

const inputSchema = z.object({ id: z.string().uuid() })

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

// 009: DB の message_type と揃えた union。旧 'other' フォールバックは 'unknown' に統一。
export type MessageType =
  | 'text'
  | 'image'
  | 'sticker'
  | 'video'
  | 'audio'
  | 'file'
  | 'unknown'

const MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'text',
  'image',
  'sticker',
  'video',
  'audio',
  'file',
  'unknown',
])

// 009: クライアントへ返す添付。s3Key は内部キーのため露出させず、
// presigned URL (1h) か null (取得不可) に変換して返す。
export type MessageAttachmentView = {
  index: number
  type: 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'unknown'
  url: string | null
}

export type MessageWithDraft = {
  id: string
  direction: 'inbound' | 'outbound'
  body: string
  message_type: MessageType
  timestamp: string
  send_status: 'sent' | 'failed' | 'pending' | null
  send_error: string | null
  attachments: MessageAttachmentView[]
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

    return withTenant(tenantId, (tx) => handleGetConversation(tx, tenantId, data.id))
  })

// 009: テスト可能性のため本体を pure handler として抽出
// (update-conversation-settings.server.ts の流儀)。RLS は呼び出し側の withTenant が
// 担保する — 他テナントの会話 ID は convRows が空になり notFound を投げるため、
// presigned URL 発行には到達しない (FR-010 / SC-006)。
export async function handleGetConversation(
  tx: TenantTx,
  tenantId: string,
  conversationId: string,
): Promise<ConversationDetail> {
  const convRows = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)

  const conv = convRows[0]
  if (!conv) {
    throw notFound()
  }

  // Reset unread_count atomically within the same transaction (RLS active)
  await tx
    .update(conversations)
    .set({ unreadCount: 0 })
    .where(eq(conversations.id, conversationId))

  const msgRows = await tx
    .select({
      id: messages.id,
      direction: messages.direction,
      body: messages.body,
      messageType: messages.messageType,
      timestamp: messages.timestamp,
      sendStatus: messages.sendStatus,
      sendError: messages.sendError,
      attachments: messages.attachments,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.timestamp))

  // Conversation-scoped active draft (at most one pending/ready row).
  const activeDraftRows = await tx
    .select({ status: aiDrafts.status, body: aiDrafts.body })
    .from(aiDrafts)
    .where(
      and(
        eq(aiDrafts.conversationId, conversationId),
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

  // 009: RLS (withTenant) を通過した行の s3Key だけを presigned URL 化する。
  // これがテナント分離の境界 (FR-010/FR-011)。s3Key はクライアントに渡さない。
  // 防御的二重化: 万一 DB に不正な s3Key が混入しても、この会話のプレフィックス
  // ({tenantId}/{conversationId}/) 以外のキーは presign しない。
  const expectedKeyPrefix = `${tenantId}/${conversationId}/`
  const toUrl = async (s3Key: string | null): Promise<string | null> => {
    if (!s3Key) return null
    if (!s3Key.startsWith(expectedKeyPrefix)) {
      console.warn({
        event: 'attachment_key_prefix_mismatch',
        tenantId,
        conversationId,
      })
      return null
    }
    return getAttachmentUrl(s3Key)
  }

  const mappedMessages: MessageWithDraft[] = await Promise.all(
    msgRows.map(async (row) => ({
      id: row.id,
      direction: row.direction as 'inbound' | 'outbound',
      body: row.body,
      message_type: (MESSAGE_TYPES.has(row.messageType)
        ? row.messageType
        : 'unknown') as MessageType,
      timestamp: row.timestamp.toISOString(),
      send_status: (row.sendStatus as MessageWithDraft['send_status']) ?? null,
      send_error: row.sendError ?? null,
      attachments: await Promise.all(
        (row.attachments ?? []).map(async (att) => ({
          index: att.index,
          type: att.type,
          url: await toUrl(att.s3Key),
        })),
      ),
      ai_draft: null,
    })),
  )

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
}
