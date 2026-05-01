import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { connectedPages, conversations, messages } from '~/server/db/schema'
import { withTenant, type TenantTx } from '~/server/db/with-tenant'
import { getMasterKey, decryptToken } from '~/server/services/crypto'
import { sendMessengerReply } from '~/server/services/messenger'

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

const inputSchema = z.object({ conversationId: z.string().uuid(), body: z.string().trim().min(1) })

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
  // 1. Load conversation and check 24h window
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

  // 2. Get page access token
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

  // 3. INSERT message with pending status
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

  // 4. Send via Meta Send API
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

export const sendReplyFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(inputSchema)
  .handler(async ({ data, context }) => {
    const tenantId = context.user.tenantId
    const sentByAuthUid = context.user.id

    // TX1 (short): validate window + fetch encrypted token + INSERT pending → commit
    type PrepOk = {
      ok: true
      customerPsid: string
      encryptedToken: Buffer
      insertedId: string
      insertedBody: string
      insertedTimestamp: Date
    }
    type PrepErr = { ok: false; error: SendReplyResult['error']; details?: string }

    const prep: PrepOk | PrepErr = await withTenant(tenantId, async (tx) => {
      const convRows = await tx
        .select({ id: conversations.id, customerPsid: conversations.customerPsid, lastInboundAt: conversations.lastInboundAt })
        .from(conversations)
        .where(eq(conversations.id, data.conversationId))
        .limit(1)

      const conv = convRows[0]
      if (!conv) return { ok: false as const, error: 'validation_failed' as const, details: 'Conversation not found' }

      if (!conv.lastInboundAt || Date.now() - new Date(conv.lastInboundAt).getTime() >= TWENTY_FOUR_HOURS_MS) {
        return { ok: false as const, error: 'outside_window' as const }
      }

      const pageRows = await tx
        .select({ pageAccessTokenEncrypted: connectedPages.pageAccessTokenEncrypted })
        .from(connectedPages)
        .innerJoin(conversations, and(eq(conversations.id, data.conversationId), eq(conversations.pageId, connectedPages.id)))
        .where(eq(connectedPages.isActive, true))
        .orderBy(desc(connectedPages.connectedAt))
        .limit(1)

      if (pageRows.length === 0) return { ok: false as const, error: 'validation_failed' as const, details: 'No connected page' }

      const insertedRows = await tx
        .insert(messages)
        .values({ tenantId, conversationId: data.conversationId, direction: 'outbound', body: data.body, messageType: 'text', timestamp: new Date(), sendStatus: 'pending', sentByAuthUid })
        .returning({ id: messages.id, body: messages.body, timestamp: messages.timestamp })

      const ins = insertedRows[0]
      return { ok: true as const, customerPsid: conv.customerPsid, encryptedToken: pageRows[0].pageAccessTokenEncrypted, insertedId: ins.id, insertedBody: ins.body, insertedTimestamp: ins.timestamp }
    })

    if (!prep.ok) return prep

    // External I/O outside DB transaction: SSM key fetch + HTTP to Meta
    let sendResult: Awaited<ReturnType<typeof sendMessengerReply>>
    try {
      const masterKey = await getMasterKey()
      const pageAccessToken = decryptToken(prep.encryptedToken, masterKey)
      sendResult = await sendMessengerReply({
        pageAccessToken,
        recipientPsid: prep.customerPsid,
        messageText: data.body,
      })
    } catch {
      // Failsafe: mark pending message as failed so it doesn't stay stuck forever
      await withTenant(tenantId, async (tx) => {
        await tx.update(messages).set({ sendStatus: 'failed', sendError: 'meta_error' }).where(eq(messages.id, prep.insertedId))
      })
      return { ok: false as const, error: 'meta_error' as const }
    }

    // TX2 (short): UPDATE message to sent/failed → commit
    return withTenant(tenantId, async (tx) => {
      if (sendResult.ok) {
        await tx.update(messages).set({ sendStatus: 'sent', metaMessageId: sendResult.messageId }).where(eq(messages.id, prep.insertedId))
        await tx.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, data.conversationId))
        return {
          ok: true as const,
          message: { id: prep.insertedId, body: prep.insertedBody, timestamp: prep.insertedTimestamp.toISOString(), send_status: 'sent' as const },
        }
      }

      const sendError: 'outside_window' | 'token_expired' | 'meta_error' | 'validation_failed' =
        sendResult.error === 'token_expired' ? 'token_expired'
        : sendResult.error === 'outside_window' ? 'outside_window'
        : 'meta_error'

      await tx.update(messages).set({ sendStatus: 'failed', sendError }).where(eq(messages.id, prep.insertedId))
      return { ok: false as const, error: sendError }
    })
  })
