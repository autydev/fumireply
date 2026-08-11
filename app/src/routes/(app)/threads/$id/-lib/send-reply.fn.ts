import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { aiDrafts, connectedPages, conversations, messages } from '~/server/db/schema'
import { withTenant } from '~/server/db/with-tenant'
import { decryptToken, getMasterKey } from '~/server/services/crypto'
import { sendMessengerReply } from '~/server/services/messenger'
import { getAttachmentUrl } from '~/server/services/media-url'
import { SEND_TOTAL_BUDGET_MS } from '~/server/services/media-upload'
import { maybeEnqueueSummaryJob } from '~/server/services/summary-trigger'
import { isUniqueViolation, META_MESSAGE_ID_UNIQUE } from '~/server/db/errors'
import {
  TWENTY_FOUR_HOURS_MS,
  logAttachmentValidationFailure,
  mapSendError,
  validateAttachment,
  type PartResult,
  type SendError,
  type SendPart,
  type SendReplyResult,
} from './send-reply.server'

export type { SendReplyResult } from './send-reply.server'

// 010: body か attachment の一方必須。attachment 省略時は従来のテキスト送信と完全同一。
const inputSchema = z
  .object({
    conversationId: z.string().uuid(),
    body: z.string().trim(),
    attachment: z.object({ s3Key: z.string() }).optional(),
  })
  .refine((d) => d.body.length > 0 || d.attachment !== undefined, {
    message: 'body or attachment required',
  })

export const sendReplyFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(inputSchema)
  .handler(async ({ data, context }): Promise<SendReplyResult> => {
    const tenantId = context.user.tenantId
    const sentByAuthUid = context.user.id

    // ─── attachment パス (parts 逐次 + 共有 deadline) ───────────────────────
    if (data.attachment) {
      return handleAttachmentSend(tenantId, sentByAuthUid, {
        conversationId: data.conversationId,
        body: data.body,
        attachment: data.attachment,
      })
    }

    // ─── legacy テキストのみパス (従来と完全一致) ─────────────────────────────
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
            console.info({
              event: 'echo_send_attribution_recovered',
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

      const sendError = mapSendError(sendResult.error)
      await tx.update(messages).set({ sendStatus: 'failed', sendError }).where(eq(messages.id, prep.insertedId))
      return { ok: false as const, error: sendError }
    })

    if (result.ok) {
      await maybeEnqueueSummaryJob(data.conversationId, tenantId)
    }

    return result
  })

// ─────────────────────────────────────────────────────────────────────────────
// 010: attachment 送信の本番配線。tx を分割 (prep / part 毎の insert・update /
// finalize) して HTTP 中は DB tx を保持しない。parts ヘルパーの契約は
// send-reply.server.ts の processSendPart と同じ (contracts M-1 の二重実装)。
// ─────────────────────────────────────────────────────────────────────────────
async function handleAttachmentSend(
  tenantId: string,
  sentByAuthUid: string,
  data: { conversationId: string; body: string; attachment: { s3Key: string } },
): Promise<SendReplyResult> {
  // TX_prep: window 検証 + page token 取得 (INSERT はパーツ毎)
  const prep = await withTenant(tenantId, async (tx) => {
    const convRows = await tx
      .select({ id: conversations.id, customerPsid: conversations.customerPsid, lastInboundAt: conversations.lastInboundAt })
      .from(conversations)
      .where(eq(conversations.id, data.conversationId))
      .limit(1)
    const conv = convRows[0]
    if (!conv) return { ok: false as const, error: 'validation_failed' as const }
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
    if (pageRows.length === 0) return { ok: false as const, error: 'validation_failed' as const }
    return { ok: true as const, customerPsid: conv.customerPsid, encryptedToken: pageRows[0].pageAccessTokenEncrypted }
  })

  if (!prep.ok) return prep

  // s3Key 検証 + HeadObject (allowlist/サイズ)
  const val = await validateAttachment(tenantId, data.conversationId, data.attachment.s3Key)
  if (!val.ok) {
    logAttachmentValidationFailure(tenantId, data.conversationId, data.attachment.s3Key, val.reason)
    return { ok: false, error: 'validation_failed' }
  }

  // Meta 送信の前に token を復号
  let pageAccessToken: string
  try {
    const masterKey = await getMasterKey()
    pageAccessToken = decryptToken(prep.encryptedToken, masterKey)
  } catch {
    return { ok: false, error: 'meta_error' }
  }

  const deadlineMs = Date.now() + SEND_TOTAL_BUDGET_MS
  const parts: SendPart[] = []
  if (data.body) parts.push({ kind: 'text', body: data.body })
  parts.push({ kind: 'image', s3Key: data.attachment.s3Key, contentType: val.contentType, sizeBytes: val.sizeBytes })

  const partResults: PartResult[] = []
  let lastOkRow: { id: string; body: string; timestamp: Date } | undefined
  let firstError: SendError | undefined

  for (const part of parts) {
    const r = await runPartLive({ tenantId, sentByAuthUid, conversationId: data.conversationId, customerPsid: prep.customerPsid, pageAccessToken }, deadlineMs, part)
    partResults.push({ kind: part.kind, ok: r.ok, error: r.ok ? undefined : r.error })
    if (r.ok) lastOkRow = r.row
    else if (!firstError) firstError = r.error
  }

  const anyOk = partResults.some((p) => p.ok)
  if (anyOk) {
    await withTenant(tenantId, async (tx) => {
      await tx.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, data.conversationId))
      await tx
        .update(aiDrafts)
        .set({ status: 'dismissed', updatedAt: new Date() })
        .where(and(eq(aiDrafts.conversationId, data.conversationId), inArray(aiDrafts.status, ['pending', 'ready'])))
    })
    await maybeEnqueueSummaryJob(data.conversationId, tenantId)
  }

  const allOk = partResults.every((p) => p.ok)
  if (allOk && lastOkRow) {
    return {
      ok: true,
      message: { id: lastOkRow.id, body: lastOkRow.body, timestamp: lastOkRow.timestamp.toISOString(), send_status: 'sent' },
      parts: partResults,
    }
  }
  return { ok: false, error: firstError ?? 'meta_error', parts: partResults }
}

interface LivePartCtx {
  tenantId: string
  sentByAuthUid: string
  conversationId: string
  customerPsid: string
  pageAccessToken: string
}

// 1 パーツの本番処理: TX_insert → HTTP 送信 → TX_update (echo claim 含む)。
async function runPartLive(
  ctx: LivePartCtx,
  deadlineMs: number,
  part: SendPart,
): Promise<{ ok: true; row: { id: string; body: string; timestamp: Date } } | { ok: false; error: SendError }> {
  // TX_insert: pending 行
  const inserted = await withTenant(ctx.tenantId, async (tx) => {
    const rows = await tx
      .insert(messages)
      .values(
        part.kind === 'text'
          ? {
              tenantId: ctx.tenantId,
              conversationId: ctx.conversationId,
              direction: 'outbound' as const,
              body: part.body,
              messageType: 'text' as const,
              timestamp: new Date(),
              sendStatus: 'pending' as const,
              sentByAuthUid: ctx.sentByAuthUid,
            }
          : {
              tenantId: ctx.tenantId,
              conversationId: ctx.conversationId,
              direction: 'outbound' as const,
              body: '',
              messageType: 'image' as const,
              attachments: [{ index: 0, type: 'image' as const, s3Key: part.s3Key, contentType: part.contentType, sizeBytes: part.sizeBytes }],
              timestamp: new Date(),
              sendStatus: 'pending' as const,
              sentByAuthUid: ctx.sentByAuthUid,
            },
      )
      .returning({ id: messages.id, body: messages.body, timestamp: messages.timestamp })
    return rows[0]
  })

  // HTTP (tx 外)
  let sendResult: Awaited<ReturnType<typeof sendMessengerReply>>
  try {
    if (part.kind === 'text') {
      sendResult = await sendMessengerReply({ pageAccessToken: ctx.pageAccessToken, recipientPsid: ctx.customerPsid, messageText: part.body, deadlineMs })
    } else {
      // presign できないときは空 URL で Meta を叩かず即失敗扱いにする (無効リクエスト回避)。
      const imageUrl = await getAttachmentUrl(part.s3Key)
      sendResult =
        imageUrl === null
          ? { ok: false, error: 'meta_server_error' }
          : await sendMessengerReply({ pageAccessToken: ctx.pageAccessToken, recipientPsid: ctx.customerPsid, imageUrl, deadlineMs })
    }
  } catch {
    await withTenant(ctx.tenantId, async (tx) => {
      await tx.update(messages).set({ sendStatus: 'failed', sendError: 'meta_error' }).where(eq(messages.id, inserted.id))
    })
    return { ok: false, error: 'meta_error' }
  }

  // TX_update: sent/failed + echo claim
  return withTenant(ctx.tenantId, async (tx) => {
    if (sendResult.ok) {
      let finalMessageId = inserted.id
      try {
        await tx.update(messages).set({ sendStatus: 'sent', metaMessageId: sendResult.messageId }).where(eq(messages.id, inserted.id))
      } catch (err) {
        if (isUniqueViolation(err, META_MESSAGE_ID_UNIQUE)) {
          await tx.delete(messages).where(eq(messages.id, inserted.id))
          const claimed = await tx
            .update(messages)
            .set({ sentByAuthUid: ctx.sentByAuthUid, sendStatus: 'sent' })
            .where(eq(messages.metaMessageId, sendResult.messageId))
            .returning({ id: messages.id })
          finalMessageId = claimed[0]?.id ?? inserted.id
          console.info({
            event: 'echo_send_attribution_recovered',
            conversationId: ctx.conversationId,
            mid: sendResult.messageId,
            droppedRowId: inserted.id,
            sentByAuthUid: ctx.sentByAuthUid,
          })
        } else {
          throw err
        }
      }
      return { ok: true as const, row: { id: finalMessageId, body: inserted.body, timestamp: inserted.timestamp } }
    }

    const sendError = mapSendError(sendResult.error)
    await tx.update(messages).set({ sendStatus: 'failed', sendError }).where(eq(messages.id, inserted.id))
    if (part.kind === 'image') {
      console.warn({
        event: 'outbound_attachment_send_failed',
        tenantId: ctx.tenantId,
        conversationId: ctx.conversationId,
        messageId: inserted.id,
        s3Key: part.s3Key,
        reason: sendResult.error === 'timeout' ? 'budget_exceeded' : 'meta_error',
      })
    }
    return { ok: false as const, error: sendError }
  })
}
