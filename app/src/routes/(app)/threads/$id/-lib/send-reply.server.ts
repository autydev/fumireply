import { and, desc, eq, inArray } from 'drizzle-orm'
import { aiDrafts, connectedPages, conversations, messages } from '~/server/db/schema'
import type { TenantTx } from '~/server/db/with-tenant'
import { env } from '~/server/env'
import { decryptToken, getMasterKey } from '~/server/services/crypto'
import { sendMessengerReply } from '~/server/services/messenger'
import { getAttachmentUrl } from '~/server/services/media-url'
import {
  MAX_ATTACHMENT_BYTES,
  SEND_TOTAL_BUDGET_MS,
  isAllowedImageType,
  isValidOutboundKey,
  verifyUploadedObject,
} from '~/server/services/media-upload'
import { isUniqueViolation, META_MESSAGE_ID_UNIQUE } from '~/server/db/errors'

export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

export type SendError = 'outside_window' | 'token_expired' | 'meta_error' | 'validation_failed'

// 010: 各パーツ (テキスト/画像) の個別成否。attachment ありのときのみ Output に付く。
export type PartResult = { kind: 'text' | 'image'; ok: boolean; error?: SendError }

export type SendReplyResult =
  | {
      ok: true
      message: { id: string; body: string; timestamp: string; send_status: 'sent' }
      parts?: PartResult[]
    }
  | {
      ok: false
      error: SendError
      details?: string
      parts?: PartResult[]
    }

// 010: 送信するパーツの内部表現。
export type SendPart =
  | { kind: 'text'; body: string }
  | { kind: 'image'; s3Key: string; contentType: string; sizeBytes: number }

// sendMessengerReply のエラーを既存 sendError union へ写像する。`timeout`
// (予算切れ含む) は新値を作らず `meta_error` に畳む (INV-4 / research D4)。
export function mapSendError(
  error: 'token_expired' | 'outside_window' | 'permission_denied' | 'invalid_request' | 'meta_server_error' | 'timeout',
): SendError {
  if (error === 'token_expired') return 'token_expired'
  if (error === 'outside_window') return 'outside_window'
  return 'meta_error'
}

// 010: 持ち込みキー検証 + HeadObject 検証。成功時は記録用の contentType/sizeBytes を返す。
// FR-010: 自テナント・自会話・outbound 以外のキーは key_rejected として弾く。
export async function validateAttachment(
  tenantId: string,
  conversationId: string,
  s3Key: string,
): Promise<
  | { ok: true; contentType: string; sizeBytes: number }
  | { ok: false; reason: 'not_configured' | 'key_rejected' | 'head_validation_failed' }
> {
  const bucket = env.MEDIA_BUCKET_NAME
  if (!bucket) return { ok: false, reason: 'not_configured' }

  if (!isValidOutboundKey(s3Key, tenantId, conversationId)) {
    console.warn({ event: 'outbound_attachment_key_rejected', tenantId, conversationId, presentedKey: s3Key })
    return { ok: false, reason: 'key_rejected' }
  }

  const head = await verifyUploadedObject({ bucket, key: s3Key })
  if (
    !head ||
    !head.contentType ||
    !isAllowedImageType(head.contentType) ||
    head.contentLength === undefined ||
    head.contentLength > MAX_ATTACHMENT_BYTES
  ) {
    return { ok: false, reason: 'head_validation_failed' }
  }
  return { ok: true, contentType: head.contentType, sizeBytes: head.contentLength }
}

// 010: attachment 検証で弾いたときの構造化ログ。key_rejected は validateAttachment 内で
// 既に出しているため、ここでは head 検証失敗を送信失敗 reason 別集計 (contracts §8) に載せる。
export function logAttachmentValidationFailure(
  tenantId: string,
  conversationId: string,
  s3Key: string,
  reason: 'not_configured' | 'key_rejected' | 'head_validation_failed',
): void {
  if (reason === 'head_validation_failed') {
    console.warn({
      event: 'outbound_attachment_send_failed',
      tenantId,
      conversationId,
      s3Key,
      reason: 'head_validation_failed',
    })
  }
}

interface PartCtx {
  tenantId: string
  conversationId: string
  sentByAuthUid: string
  customerPsid: string
  pageAccessToken: string
}

// 1 パーツを処理する共有ヘルパー: pending INSERT → Meta 送信 (共有 deadline) →
// sent/failed 確定 (mid unique 衝突時の echo claim 回復含む)。単一 tx 上で完結する
// テスト用パス。本番 fn.ts は tx を分割するため独自配線 (contracts M-1)。
export async function processSendPart(
  tx: TenantTx,
  ctx: PartCtx,
  deadlineMs: number,
  part: SendPart,
): Promise<{ ok: true; row: { id: string; body: string; timestamp: Date } } | { ok: false; error: SendError }> {
  const insertValues =
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
          attachments: [
            { index: 0, type: 'image' as const, s3Key: part.s3Key, contentType: part.contentType, sizeBytes: part.sizeBytes },
          ],
          timestamp: new Date(),
          sendStatus: 'pending' as const,
          sentByAuthUid: ctx.sentByAuthUid,
        }

  const insertedRows = await tx
    .insert(messages)
    .values(insertValues)
    .returning({ id: messages.id, body: messages.body, timestamp: messages.timestamp })
  const inserted = insertedRows[0]

  let sendResult: Awaited<ReturnType<typeof sendMessengerReply>>
  if (part.kind === 'text') {
    sendResult = await sendMessengerReply({
      pageAccessToken: ctx.pageAccessToken,
      recipientPsid: ctx.customerPsid,
      messageText: part.body,
      deadlineMs,
    })
  } else {
    // presign できないときは空 URL で Meta を叩かず即失敗扱いにする (無効リクエスト回避)。
    const imageUrl = await getAttachmentUrl(part.s3Key)
    sendResult =
      imageUrl === null
        ? { ok: false, error: 'meta_server_error' }
        : await sendMessengerReply({
            pageAccessToken: ctx.pageAccessToken,
            recipientPsid: ctx.customerPsid,
            imageUrl,
            deadlineMs,
          })
  }

  if (sendResult.ok) {
    let finalMessageId = inserted.id
    try {
      await tx
        .update(messages)
        .set({ sendStatus: 'sent', metaMessageId: sendResult.messageId })
        .where(eq(messages.id, inserted.id))
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
    return { ok: true, row: { id: finalMessageId, body: inserted.body, timestamp: inserted.timestamp } }
  }

  const sendError = mapSendError(sendResult.error)
  await tx.update(messages).set({ sendStatus: 'failed', sendError }).where(eq(messages.id, inserted.id))
  if (part.kind === 'image') {
    const reason = sendResult.error === 'timeout' ? 'budget_exceeded' : 'meta_error'
    console.warn({
      event: 'outbound_attachment_send_failed',
      tenantId: ctx.tenantId,
      conversationId: ctx.conversationId,
      messageId: inserted.id,
      s3Key: part.s3Key,
      reason,
    })
  }
  return { ok: false, error: sendError }
}

// Exported for unit testing — exercises the full DB + send flow via a mock tx.
// Production code uses sendReplyFn.handler which splits the logic into short
// withTenant transactions with external I/O (SSM + HTTP) between them.
export async function handleSendReply(
  tx: TenantTx,
  tenantId: string,
  sentByAuthUid: string,
  data: { conversationId: string; body: string; attachment?: { s3Key: string } },
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

  const ctx: PartCtx = {
    tenantId,
    conversationId: data.conversationId,
    sentByAuthUid,
    customerPsid: conv.customerPsid,
    pageAccessToken,
  }

  // ─── attachment パス (parts 逐次) ───────────────────────────────────────
  if (data.attachment) {
    const val = await validateAttachment(tenantId, data.conversationId, data.attachment.s3Key)
    if (!val.ok) {
      logAttachmentValidationFailure(tenantId, data.conversationId, data.attachment.s3Key, val.reason)
      return { ok: false, error: 'validation_failed' }
    }

    const deadlineMs = Date.now() + SEND_TOTAL_BUDGET_MS
    const parts: SendPart[] = []
    if (data.body) parts.push({ kind: 'text', body: data.body })
    parts.push({ kind: 'image', s3Key: data.attachment.s3Key, contentType: val.contentType, sizeBytes: val.sizeBytes })

    const partResults: PartResult[] = []
    let lastOkRow: { id: string; body: string; timestamp: Date } | undefined
    let firstError: SendError | undefined
    for (const part of parts) {
      const r = await processSendPart(tx, ctx, deadlineMs, part)
      partResults.push({ kind: part.kind, ok: r.ok, error: r.ok ? undefined : r.error })
      if (r.ok) lastOkRow = r.row
      else if (!firstError) firstError = r.error
    }

    const anyOk = partResults.some((p) => p.ok)
    if (anyOk) {
      await tx.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, data.conversationId))
      await tx
        .update(aiDrafts)
        .set({ status: 'dismissed', updatedAt: new Date() })
        .where(and(eq(aiDrafts.conversationId, data.conversationId), inArray(aiDrafts.status, ['pending', 'ready'])))
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

  // ─── legacy テキストのみパス (attachment 省略時は従来と完全一致) ───────────
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
    // 006: UNIQUE 違反 catch + attribute 補正。詳細は send-reply.fn.ts の同名コメント参照。
    let finalMessageId = inserted.id
    try {
      await tx
        .update(messages)
        .set({ sendStatus: 'sent', metaMessageId: sendResult.messageId })
        .where(eq(messages.id, inserted.id))
    } catch (err) {
      if (isUniqueViolation(err, META_MESSAGE_ID_UNIQUE)) {
        await tx.delete(messages).where(eq(messages.id, inserted.id))
        const claimed = await tx
          .update(messages)
          .set({ sentByAuthUid, sendStatus: 'sent' })
          .where(eq(messages.metaMessageId, sendResult.messageId))
          .returning({ id: messages.id })
        finalMessageId = claimed[0]?.id ?? inserted.id
        console.info({
          event: 'echo_send_attribution_recovered',
          conversationId: data.conversationId,
          mid: sendResult.messageId,
          droppedRowId: inserted.id,
          sentByAuthUid,
        })
      } else {
        throw err
      }
    }

    await tx
      .update(conversations)
      .set({ lastMessageAt: new Date() })
      .where(eq(conversations.id, data.conversationId))

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
      ok: true,
      message: {
        id: finalMessageId,
        body: inserted.body,
        timestamp: inserted.timestamp.toISOString(),
        send_status: 'sent',
      },
    }
  }

  const sendError = mapSendError(sendResult.error)

  await tx
    .update(messages)
    .set({ sendStatus: 'failed', sendError })
    .where(eq(messages.id, inserted.id))

  return { ok: false, error: sendError }
}
