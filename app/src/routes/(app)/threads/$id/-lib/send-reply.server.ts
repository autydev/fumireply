import { and, desc, eq } from 'drizzle-orm'
import { connectedPages, conversations, messages } from '~/server/db/schema'
import type { TenantTx } from '~/server/db/with-tenant'
import { decryptToken, getMasterKey } from '~/server/services/crypto'
import { sendMessengerReply } from '~/server/services/messenger'

export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

export type SendReplyResult =
  | {
      ok: true
      message: { id: string; body: string; timestamp: string; send_status: 'sent' }
    }
  | {
      ok: false
      error: 'outside_window' | 'token_expired' | 'meta_error' | 'validation_failed'
      details?: string
    }

// Exported for unit testing — exercises the full DB + send flow via a mock tx.
// Production code uses sendReplyFn.handler which splits the logic into two short
// withTenant transactions with external I/O (SSM + HTTP) between them.
export async function handleSendReply(
  tx: TenantTx,
  tenantId: string,
  sentByAuthUid: string,
  data: { conversationId: string; body: string },
): Promise<SendReplyResult> {
  const convRows = await tx
    .select({
      id: conversations.id,
      customerPsid: conversations.customerPsid,
      lastInboundAt: conversations.lastInboundAt,
    })
    .from(conversations)
    .where(eq(conversations.id, data.conversationId))
    .limit(1)

  const conv = convRows[0]
  if (!conv) {
    return { ok: false, error: 'validation_failed', details: 'Conversation not found' }
  }

  if (
    !conv.lastInboundAt ||
    Date.now() - new Date(conv.lastInboundAt).getTime() >= TWENTY_FOUR_HOURS_MS
  ) {
    return { ok: false, error: 'outside_window' }
  }

  const pageRows = await tx
    .select({
      pageAccessTokenEncrypted: connectedPages.pageAccessTokenEncrypted,
    })
    .from(connectedPages)
    .innerJoin(
      conversations,
      and(
        eq(conversations.id, data.conversationId),
        eq(conversations.pageId, connectedPages.id),
      ),
    )
    .where(eq(connectedPages.isActive, true))
    .orderBy(desc(connectedPages.connectedAt))
    .limit(1)

  if (pageRows.length === 0) {
    return { ok: false, error: 'validation_failed', details: 'No connected page' }
  }

  const masterKey = await getMasterKey()
  const pageAccessToken = decryptToken(pageRows[0].pageAccessTokenEncrypted, masterKey)

  const insertedRows = await tx
    .insert(messages)
    .values({
      tenantId,
      conversationId: data.conversationId,
      direction: 'outbound',
      body: data.body,
      messageType: 'text',
      timestamp: new Date(),
      sendStatus: 'pending',
      sentByAuthUid,
    })
    .returning({ id: messages.id, body: messages.body, timestamp: messages.timestamp })

  const inserted = insertedRows[0]

  const sendResult = await sendMessengerReply({
    pageAccessToken,
    recipientPsid: conv.customerPsid,
    messageText: data.body,
  })

  if (sendResult.ok) {
    await tx
      .update(messages)
      .set({ sendStatus: 'sent', metaMessageId: sendResult.messageId })
      .where(eq(messages.id, inserted.id))

    await tx
      .update(conversations)
      .set({ lastMessageAt: new Date() })
      .where(eq(conversations.id, data.conversationId))

    return {
      ok: true,
      message: {
        id: inserted.id,
        body: inserted.body,
        timestamp: inserted.timestamp.toISOString(),
        send_status: 'sent',
      },
    }
  }

  const sendError: 'outside_window' | 'token_expired' | 'meta_error' | 'validation_failed' =
    sendResult.error === 'token_expired'
      ? 'token_expired'
      : sendResult.error === 'outside_window'
        ? 'outside_window'
        : 'meta_error'

  await tx
    .update(messages)
    .set({ sendStatus: 'failed', sendError })
    .where(eq(messages.id, inserted.id))

  return { ok: false, error: sendError }
}
