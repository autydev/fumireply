import { createServerFn } from '@tanstack/react-start'
import { desc, sql } from 'drizzle-orm'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { conversations } from '~/server/db/schema'
import { withTenant } from '~/server/db/with-tenant'

export type ConversationSummary = {
  id: string
  customer_psid: string
  customer_name: string | null
  last_message_at: string
  last_inbound_at: string | null
  unread_count: number
  last_message_preview: string
  last_message_direction: 'inbound' | 'outbound'
  within_24h_window: boolean
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000
const DEFAULT_LIMIT = 50

export const listConversationsFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const rows = await withTenant(context.user.tenantId, async (tx) => {
      return tx
        .select({
          id: conversations.id,
          customerPsid: conversations.customerPsid,
          customerName: conversations.customerName,
          lastMessageAt: conversations.lastMessageAt,
          lastInboundAt: conversations.lastInboundAt,
          unreadCount: conversations.unreadCount,
          lastMessageBody: sql<string | null>`(
            SELECT body FROM messages
            WHERE conversation_id = conversations.id
            ORDER BY timestamp DESC LIMIT 1
          )`,
          lastMessageDirection: sql<string | null>`(
            SELECT direction FROM messages
            WHERE conversation_id = conversations.id
            ORDER BY timestamp DESC LIMIT 1
          )`,
        })
        .from(conversations)
        .orderBy(desc(conversations.lastMessageAt))
        .limit(DEFAULT_LIMIT)
    })

    const now = Date.now()

    const result: ConversationSummary[] = rows.map((row) => ({
      id: row.id,
      customer_psid: row.customerPsid,
      customer_name: row.customerName ?? null,
      last_message_at: row.lastMessageAt?.toISOString() ?? new Date(0).toISOString(),
      last_inbound_at: row.lastInboundAt?.toISOString() ?? null,
      unread_count: row.unreadCount,
      last_message_preview: (row.lastMessageBody ?? '').slice(0, 100),
      last_message_direction: (row.lastMessageDirection ?? 'inbound') as 'inbound' | 'outbound',
      within_24h_window: row.lastInboundAt
        ? now - new Date(row.lastInboundAt).getTime() < TWENTY_FOUR_HOURS_MS
        : false,
    }))

    return { conversations: result }
  })
