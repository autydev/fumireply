import { createServerFn } from '@tanstack/react-start'
import { sql } from 'drizzle-orm'
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

type LastMessageInfo = { body: string | null; direction: string | null } | null

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
          createdAt: conversations.createdAt,
          unreadCount: conversations.unreadCount,
          // Single correlated subquery returns body+direction as JSON, avoiding two round-trips
          lastMessageInfo: sql<LastMessageInfo>`(
            SELECT json_build_object('body', body, 'direction', direction)
            FROM messages
            WHERE conversation_id = conversations.id
            ORDER BY timestamp DESC LIMIT 1
          )`,
        })
        .from(conversations)
        // NULLS LAST: conversations with no messages yet sort below those with messages
        .orderBy(sql`${conversations.lastMessageAt} DESC NULLS LAST`)
        .limit(DEFAULT_LIMIT)
    })

    const now = Date.now()

    const result: ConversationSummary[] = rows.map((row) => {
      const info = row.lastMessageInfo
      return {
        id: row.id,
        customer_psid: row.customerPsid,
        customer_name: row.customerName ?? null,
        // Fall back to createdAt (always non-null) rather than epoch for conversations
        // that have not yet received any messages
        last_message_at: (row.lastMessageAt ?? row.createdAt).toISOString(),
        last_inbound_at: row.lastInboundAt?.toISOString() ?? null,
        unread_count: row.unreadCount,
        last_message_preview: (info?.body ?? '').slice(0, 100),
        last_message_direction: (info?.direction ?? 'inbound') as 'inbound' | 'outbound',
        within_24h_window: row.lastInboundAt
          ? now - new Date(row.lastInboundAt).getTime() < TWENTY_FOUR_HOURS_MS
          : false,
      }
    })

    return { conversations: result }
  })
