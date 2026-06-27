import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { aiDrafts, connectedPages, conversations, messages } from '~/server/db/schema'
import { withTenant } from '~/server/db/with-tenant'
import { decryptToken, getMasterKey } from '~/server/services/crypto'
import { sendMessengerReply } from '~/server/services/messenger'
import { maybeEnqueueSummaryJob } from '~/server/services/summary-trigger'
import { isUniqueViolation, META_MESSAGE_ID_UNIQUE } from '~/server/db/errors'
import { TWENTY_FOUR_HOURS_MS, type SendReplyResult } from './send-reply.server'

export type { SendReplyResult } from './send-reply.server'

const inputSchema = z.object({ conversationId: z.string().uuid(), body: z.string().trim().min(1) })

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
    type PrepErr = { ok: false; error: Extract<SendReplyResult, { ok: false }>['error']; details?: string }

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
    const result = await withTenant(tenantId, async (tx) => {
      if (sendResult.ok) {
        // 006: echo が `mid` 書き戻し前に到着して同 mid で既に行を作っているケースを catch。
        // UNIQUE 違反のときは tentative 行を DELETE して echo 行に sentByAuthUid を attribute。
        // 最終的に 1 行に収束させる (FR-008a)。
        let finalMessageId = prep.insertedId
        try {
          await tx
            .update(messages)
            .set({ sendStatus: 'sent', metaMessageId: sendResult.messageId })
            .where(eq(messages.id, prep.insertedId))
        } catch (err) {
          if (isUniqueViolation(err, META_MESSAGE_ID_UNIQUE)) {
            await tx.delete(messages).where(eq(messages.id, prep.insertedId))
            const claimed = await tx
              .update(messages)
              .set({ sentByAuthUid, sendStatus: 'sent' })
              .where(eq(messages.metaMessageId, sendResult.messageId))
              .returning({ id: messages.id })
            finalMessageId = claimed[0]?.id ?? prep.insertedId
            console.info('echo_send_attribution_recovered', {
              conversationId: data.conversationId,
              mid: sendResult.messageId,
              droppedRowId: prep.insertedId,
              sentByAuthUid,
            })
          } else {
            throw err
          }
        }
        await tx.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, data.conversationId))
        // Consume the active draft: sending a reply answers the pending batch.
        await tx
          .update(aiDrafts)
          .set({ status: 'dismissed', updatedAt: new Date() })
          .where(
            and(
              eq(aiDrafts.conversationId, data.conversationId),
              inArray(aiDrafts.status, ['pending', 'ready']),
            ),
          )
        return {
          ok: true as const,
          message: { id: finalMessageId, body: prep.insertedBody, timestamp: prep.insertedTimestamp.toISOString(), send_status: 'sent' as const },
        }
      }

      const sendError: 'outside_window' | 'token_expired' | 'meta_error' | 'validation_failed' =
        sendResult.error === 'token_expired' ? 'token_expired'
        : sendResult.error === 'outside_window' ? 'outside_window'
        : 'meta_error'

      await tx.update(messages).set({ sendStatus: 'failed', sendError }).where(eq(messages.id, prep.insertedId))
      return { ok: false as const, error: sendError }
    })

    if (result.ok) {
      await maybeEnqueueSummaryJob(data.conversationId, tenantId)
    }

    return result
  })
