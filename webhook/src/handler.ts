import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { createDecipheriv } from 'node:crypto'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDbAdmin } from './db/client'
import { withTenant, type TenantTx } from './db/with-tenant'
import {
  aiDrafts,
  connectedPages,
  conversations,
  messages,
  type MessageAttachment,
} from './db/schema'
import { downloadAttachment, storeAttachment } from './services/media'
import { getSsmParameter } from './services/ssm'
import { maybeEnqueueSummaryJob } from './services/summary-trigger'
import { env } from './env'
import { verifySignature } from './signature'

const sqsClient = new SQSClient({ region: env.AWS_REGION })

const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

let masterKeyCache: Buffer | null = null

async function getMasterKey(): Promise<Buffer> {
  if (masterKeyCache) return masterKeyCache
  const encoded = await getSsmParameter(env.MASTER_KEY_SSM_PATH)
  const key = Buffer.from(encoded.trim(), 'base64')
  masterKeyCache = key
  return key
}

function decryptToken(blob: Buffer, masterKey: Buffer): string {
  const iv = blob.subarray(0, IV_LENGTH)
  const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

async function fetchCustomerName(psid: string, pageAccessToken: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${GRAPH_API_BASE}/${psid}?fields=name&access_token=${pageAccessToken}`,
      { signal: AbortSignal.timeout(5000) },
    )
    if (!res.ok) {
      const errBody = await res.json().catch(() => null)
      console.error('fetch_customer_name_api_error', { psid, status: res.status, body: errBody })
      return null
    }
    const data = (await res.json()) as { name?: string }
    if (typeof data.name !== 'string') {
      console.warn('fetch_customer_name_no_name_field', { psid, data })
      return null
    }
    return data.name
  } catch (err) {
    console.error('fetch_customer_name_network_error', { psid, err })
    return null
  }
}

const attachmentSchema = z.object({
  type: z.string(),
  payload: z
    .object({
      sticker_id: z.number().optional(),
      url: z.string().optional(),
    })
    .optional(),
})

const messageSchema = z.object({
  mid: z.string(),
  text: z.string().optional(),
  is_echo: z.boolean().optional(),
  attachments: z.array(attachmentSchema).optional(),
})

const messagingEventSchema = z.object({
  sender: z.object({ id: z.string() }),
  recipient: z.object({ id: z.string() }),
  timestamp: z.number(),
  message: messageSchema.optional(),
  delivery: z.unknown().optional(),
  read: z.unknown().optional(),
})

const entrySchema = z.object({
  id: z.string(),
  time: z.number(),
  messaging: z.array(messagingEventSchema).default([]),
})

const webhookPayloadSchema = z.object({
  object: z.literal('page'),
  entry: z.array(entrySchema),
})

type MessagingEvent = z.infer<typeof messagingEventSchema>

// 009: 保存対象となる添付種別 (sticker は Meta 定型画像、unknown は URL 不定のため対象外)
const STORABLE_ATTACHMENT_TYPES: ReadonlySet<MessageAttachment['type']> = new Set([
  'image',
  'video',
  'audio',
  'file',
])

// 009: リトライ間隔。Meta の CDN URL は受信直後しか生存が保証されないため
// 短い即時リトライのみ行う (spec Q2: 最大 2 回再試行 = 計 3 試行)。
const ATTACHMENT_RETRY_DELAYS_MS = [200, 500]

// 009: メディア処理全体の時間予算。Lambda timeout 20s の内側で必ずメッセージ INSERT に
// 到達させるための上限 (FR-003)。予算を使い切ったら残りの添付は time_budget_exceeded で
// 「取得不可」確定し、取り込みを続行する。1 試行あたりの fetch timeout も残予算でクランプする。
const MEDIA_TOTAL_BUDGET_MS = 12_000
const MEDIA_MIN_ATTEMPT_MS = 1_000
const MEDIA_FETCH_TIMEOUT_MS = 8_000

export interface AttachmentPlan {
  index: number
  type: MessageAttachment['type']
  url: string | null
  shouldStore: boolean
}

// 009: inbound / echo 共通の種別判定。006 の determineMessageType /
// determineEchoMessageType を置換 — body に添付 URL を入れる経路は廃止し (FR-004)、
// 全添付を index 順に AttachmentPlan として返す (先頭 1 件のみの制限を撤廃)。
export function classifyAttachments(msg: z.infer<typeof messageSchema>): {
  messageType: string
  body: string
  attachments: AttachmentPlan[]
} {
  const attachments: AttachmentPlan[] = (msg.attachments ?? []).map((att, index) => {
    let type: MessageAttachment['type']
    if (att.payload?.sticker_id !== undefined) {
      type = 'sticker'
    } else if (
      att.type === 'image' ||
      att.type === 'video' ||
      att.type === 'audio' ||
      att.type === 'file'
    ) {
      type = att.type
    } else {
      type = 'unknown'
    }
    const url = att.payload?.url ?? null
    return {
      index,
      type,
      url,
      shouldStore: STORABLE_ATTACHMENT_TYPES.has(type) && url !== null,
    }
  })

  if (msg.text !== undefined) {
    return { messageType: 'text', body: msg.text, attachments }
  }
  return {
    messageType: attachments[0]?.type ?? 'unknown',
    body: '',
    attachments,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 009: 1 添付のダウンロード + S3 保存。oversize は決定的失敗なのでリトライしない。
// それ以外 (timeout / network_error / http_error / put_failed) は短い即時リトライを行い、
// 使い切るか deadline (メディア処理全体の時間予算) に達したら s3Key: null で確定する。
async function fetchAndStoreAttachment(
  plan: AttachmentPlan,
  url: string,
  ctx: { tenantId: string; conversationId: string; mid: string },
  deadline: number,
): Promise<MessageAttachment> {
  const { tenantId, conversationId, mid } = ctx
  const maxAttempts = 1 + ATTACHMENT_RETRY_DELAYS_MS.length
  let lastReason = 'network_error'
  let lastError: string | undefined
  let attemptsMade = 0

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remainingMs = deadline - Date.now()
    if (remainingMs < MEDIA_MIN_ATTEMPT_MS) {
      lastReason = 'time_budget_exceeded'
      break
    }
    attemptsMade = attempt

    const dl = await downloadAttachment(url, {
      timeoutMs: Math.min(MEDIA_FETCH_TIMEOUT_MS, remainingMs),
    })

    if (dl.ok) {
      try {
        const s3Key = await storeAttachment({
          bucket: env.MEDIA_BUCKET_NAME,
          tenantId,
          conversationId,
          mid,
          index: plan.index,
          buffer: dl.buffer,
          contentType: dl.contentType,
        })
        console.info({
          event: 'attachment_stored',
          tenantId,
          conversationId,
          mid,
          index: plan.index,
          type: plan.type,
          sizeBytes: dl.sizeBytes,
        })
        return {
          index: plan.index,
          type: plan.type,
          s3Key,
          contentType: dl.contentType,
          sizeBytes: dl.sizeBytes,
        }
      } catch (err) {
        // S3 側の失敗理由 (AccessDenied 等) を運用ログで判別できるよう残す
        lastReason = 'put_failed'
        lastError = err instanceof Error ? err.message : String(err)
      }
    } else if (dl.reason === 'oversize') {
      console.warn({
        event: 'attachment_skipped_oversize',
        tenantId,
        mid,
        index: plan.index,
        type: plan.type,
      })
      return { index: plan.index, type: plan.type, s3Key: null }
    } else {
      lastReason = dl.reason
    }

    if (attempt < maxAttempts) {
      const delay = ATTACHMENT_RETRY_DELAYS_MS[attempt - 1] ?? 0
      if (deadline - Date.now() <= delay) {
        lastReason = 'time_budget_exceeded'
        break
      }
      await sleep(delay)
    }
  }

  console.warn({
    event: 'attachment_download_failed',
    tenantId,
    mid,
    index: plan.index,
    type: plan.type,
    attempts: attemptsMade,
    reason: lastReason,
    ...(lastError !== undefined ? { error: lastError } : {}),
  })
  return { index: plan.index, type: plan.type, s3Key: null }
}

// 009: 全添付の保存を逐次実行し、messages.attachments に入れる値を確定する。
// メッセージ INSERT の成否とは独立 — ここでの失敗は s3Key: null に落ちるだけで
// 呼び出し側の取り込みは必ず続行される (FR-003)。処理全体で MEDIA_TOTAL_BUDGET_MS の
// 時間予算を共有し、Lambda timeout (20s) 前に必ず INSERT へ到達する。
// conversationId が null のとき (MEDIA_BUCKET_NAME 未設定) は保存対象をすべて
// bucket_not_configured で記録する。
async function resolveAttachments(
  plans: AttachmentPlan[],
  ctx: { tenantId: string; conversationId: string | null; mid: string },
): Promise<MessageAttachment[] | null> {
  if (plans.length === 0) return null

  const deadline = Date.now() + MEDIA_TOTAL_BUDGET_MS
  const results: MessageAttachment[] = []
  for (const plan of plans) {
    if (!plan.shouldStore || plan.url === null) {
      results.push({ index: plan.index, type: plan.type, s3Key: null })
      continue
    }
    if (!env.MEDIA_BUCKET_NAME || ctx.conversationId === null) {
      console.warn({
        event: 'attachment_download_failed',
        tenantId: ctx.tenantId,
        mid: ctx.mid,
        index: plan.index,
        type: plan.type,
        attempts: 0,
        reason: 'bucket_not_configured',
      })
      results.push({ index: plan.index, type: plan.type, s3Key: null })
      continue
    }
    results.push(
      await fetchAndStoreAttachment(
        plan,
        plan.url,
        {
          tenantId: ctx.tenantId,
          conversationId: ctx.conversationId,
          mid: ctx.mid,
        },
        deadline,
      ),
    )
  }
  return results
}

async function upsertConversation(
  tx: TenantTx,
  tenantId: string,
  pageUuid: string,
  customerPsid: string,
): Promise<{ id: string; customerName: string | null }> {
  const [conv] = await tx
    .insert(conversations)
    .values({
      tenantId,
      pageId: pageUuid,
      customerPsid,
    })
    .onConflictDoUpdate({
      target: [conversations.pageId, conversations.customerPsid],
      set: { customerPsid: sql`excluded.customer_psid` },
    })
    .returning({ id: conversations.id, customerName: conversations.customerName })

  if (!conv) throw new Error('Failed to upsert conversation')
  return conv
}

interface TxResult {
  conversationId: string
  newMessageId: string | null
  needsNameFetch: boolean
}

async function processMessagingEvent(
  event: MessagingEvent,
  tenantId: string,
  pageUuid: string,
  pageAccessTokenEncrypted: Buffer,
): Promise<{ messageId: string; conversationId: string } | null> {
  const msg = event.message
  if (!msg) return null

  const { mid, is_echo } = msg
  const ts = event.timestamp

  // 009: S3 キーが conversationId を含むため、保存対象の添付があるときだけ
  // 会話を先に解決する (idempotent upsert)。ダウンロード + PutObject を DB
  // トランザクション外で行うための前段で、本体 tx 側の upsert はそのまま残す
  // (2 回目の upsert は同一行に収束するだけで無害)。この前段で会話行だけが先に
  // 生まれ、直後にプロセスが落ちると空会話が一時的に残りうるが、upsert は冪等で
  // Meta の再配信により自己修復する (時間予算により INSERT 未達自体が例外的)。
  // 同じ前段で既存 mid を確認し、再配信 (重複) ならダウンロードを丸ごと省いて
  // 最大 25MB × N の無駄な再取得を避ける — INSERT はどのみち conflict で no-op。
  const prepareMediaAttachments = async (
    customerPsid: string,
    plans: AttachmentPlan[],
    mid: string,
  ): Promise<MessageAttachment[] | null> => {
    if (plans.length === 0) return null
    if (!env.MEDIA_BUCKET_NAME || !plans.some((p) => p.shouldStore)) {
      return resolveAttachments(plans, { tenantId, conversationId: null, mid })
    }
    const pre = await withTenant(tenantId, async (tx) => {
      const conv = await upsertConversation(tx, tenantId, pageUuid, customerPsid)
      const existing = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.metaMessageId, mid))
        .limit(1)
      return { conversationId: conv.id, midExists: existing.length > 0 }
    })
    if (pre.midExists) return null
    return resolveAttachments(plans, { tenantId, conversationId: pre.conversationId, mid })
  }

  if (is_echo) {
    // 006: echo は (a) 既存自送信行があれば sendStatus を sent に確定 (UPDATE), (b) 既存行が
    // 無ければ外部送信として新規 outbound を INSERT する。`meta_message_id` UNIQUE 制約上の
    // UPSERT 一発で両ケースを扱う。`(xmax = 0)` は INSERT 経路で true (新規行)、UPDATE 経路で
    // false (既存行を更新) を返す PostgreSQL イディオム。FR-008 / FR-008a / Q3 (timestamp 不変)。
    // 009: echo の添付も inbound と同じパイプラインで保存する (FR-009)。UPSERT の SET は
    // 従来どおり sendStatus のみ — 既存自送信行の attachments を echo で上書きしない。
    const recipientPsid = event.recipient.id
    const { messageType, body, attachments: plans } = classifyAttachments(msg)
    const attachments = await prepareMediaAttachments(recipientPsid, plans, mid)

    const outcome = await withTenant(tenantId, async (tx) => {
      const conv = await upsertConversation(tx, tenantId, pageUuid, recipientPsid)
      const inserted = await tx
        .insert(messages)
        .values({
          tenantId,
          conversationId: conv.id,
          direction: 'outbound',
          metaMessageId: mid,
          body,
          messageType,
          timestamp: new Date(ts),
          sendStatus: 'sent',
          sentByAuthUid: null,
          attachments,
        })
        .onConflictDoUpdate({
          target: messages.metaMessageId,
          set: { sendStatus: 'sent' },
        })
        .returning({
          inserted: sql<boolean>`(xmax = 0)`,
        })
      // conv.id を会話 ID として返す。messages.id (= inserted[0].id) ではない点に注意。
      return { conversationId: conv.id, inserted: inserted[0]?.inserted ?? false }
    })

    if (outcome?.inserted) {
      console.info({
        event: 'external_echo_ingested',
        conversationId: outcome.conversationId,
        mid,
        pageId: pageUuid,
        messageType,
        bodyLength: body.length,
        tsMs: ts,
      })
    } else if (outcome) {
      console.info({
        event: 'self_echo_confirmed',
        conversationId: outcome.conversationId,
        mid,
        pageId: pageUuid,
      })
    }
    return null
  }

  const psid = event.sender.id
  const { messageType, body, attachments: plans } = classifyAttachments(msg)
  const attachments = await prepareMediaAttachments(psid, plans, mid)

  const txResult = await withTenant(tenantId, async (tx): Promise<TxResult | null> => {
    const conv = await upsertConversation(tx, tenantId, pageUuid, psid)

    const inserted = await tx
      .insert(messages)
      .values({
        tenantId,
        conversationId: conv.id,
        direction: 'inbound',
        metaMessageId: mid,
        body,
        messageType,
        timestamp: new Date(ts),
        attachments,
      })
      .onConflictDoNothing()
      .returning({ id: messages.id })

    const newMsg = inserted[0]
    if (!newMsg) {
      return { conversationId: conv.id, newMessageId: null, needsNameFetch: !conv.customerName }
    }

    await tx
      .update(conversations)
      .set({
        lastInboundAt: new Date(ts),
        lastMessageAt: new Date(ts),
        unreadCount: sql`${conversations.unreadCount} + 1`,
      })
      .where(eq(conversations.id, conv.id))

    if (messageType !== 'text') {
      return { conversationId: conv.id, newMessageId: null, needsNameFetch: !conv.customerName }
    }

    // 005: stale-pending guard — if an active draft is already pending and was
    // updated recently (< STALE_PENDING_GUARD_SECONDS), a regenerate or another
    // recent auto-batch is in flight; skip SQS publish so we don't fight the
    // running job. The worker emits a follow-up auto-batch on regenerate success
    // when a newer inbound arrived. Only the anchor (message_id) is refreshed so
    // the worker (or follow-up) sees the latest inbound.
    const STALE_PENDING_GUARD_MS = 120_000
    const [existingDraft] = await tx
      .select({ status: aiDrafts.status, updatedAt: aiDrafts.updatedAt })
      .from(aiDrafts)
      .where(
        and(
          eq(aiDrafts.conversationId, conv.id),
          inArray(aiDrafts.status, ['pending', 'ready']),
        ),
      )
      .limit(1)

    const isFreshPending =
      existingDraft?.status === 'pending' &&
      Date.now() - new Date(existingDraft.updatedAt).getTime() < STALE_PENDING_GUARD_MS

    if (isFreshPending) {
      await tx
        .update(aiDrafts)
        .set({ messageId: newMsg.id, updatedAt: new Date() })
        .where(
          and(
            eq(aiDrafts.conversationId, conv.id),
            eq(aiDrafts.status, 'pending'),
          ),
        )
      console.info('draft_enqueue_skipped_fresh_pending', { conversationId: conv.id })
      return { conversationId: conv.id, newMessageId: null, needsNameFetch: !conv.customerName }
    }

    // Conversation-scoped draft: reuse the active (pending/ready) draft if one
    // exists, otherwise create a fresh pending one. The actual generation is
    // debounced + coalesced downstream, so this only marks "a draft is due".
    const updated = await tx
      .update(aiDrafts)
      .set({ status: 'pending', messageId: newMsg.id, updatedAt: new Date() })
      .where(
        and(
          eq(aiDrafts.conversationId, conv.id),
          inArray(aiDrafts.status, ['pending', 'ready']),
        ),
      )
      .returning({ id: aiDrafts.id })

    if (updated.length === 0) {
      await tx
        .insert(aiDrafts)
        .values({ tenantId, conversationId: conv.id, messageId: newMsg.id, status: 'pending' })
        .onConflictDoNothing()
    }

    return {
      conversationId: conv.id,
      newMessageId: newMsg.id,
      needsNameFetch: !conv.customerName,
    }
  })

  if (!txResult) return null

  // Fetch and store the sender's name only for new conversations (customerName is null).
  // Done outside the transaction to avoid holding a DB connection during the API call.
  if (txResult.needsNameFetch) {
    try {
      const masterKey = await getMasterKey()
      const pageAccessToken = decryptToken(pageAccessTokenEncrypted, masterKey)
      const name = await fetchCustomerName(psid, pageAccessToken)
      if (name) {
        await withTenant(tenantId, async (tx) => {
          await tx
            .update(conversations)
            .set({ customerName: name })
            .where(eq(conversations.id, txResult.conversationId))
        })
      }
    } catch (err) {
      console.error('fetch_customer_name_failed', { psid, err })
    }
  }

  if (!txResult.newMessageId) return null
  return { messageId: txResult.newMessageId, conversationId: txResult.conversationId }
}

async function handleGet(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const qs = event.queryStringParameters ?? {}
  const mode = qs['hub.mode']
  const challenge = qs['hub.challenge'] ?? ''
  const token = qs['hub.verify_token'] ?? ''

  if (mode !== 'subscribe') {
    return { statusCode: 403, body: 'Forbidden' }
  }

  const ssmPrefix = env.SSM_PATH_PREFIX.replace(/\/$/, '')
  const verifyToken = await getSsmParameter(`${ssmPrefix}/meta/webhook-verify-token`)

  if (token !== verifyToken) {
    return { statusCode: 403, body: 'Forbidden' }
  }

  return { statusCode: 200, body: challenge }
}

async function handlePost(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
    : (event.body ?? '')

  const sigHeader =
    event.headers['x-hub-signature-256'] ?? event.headers['X-Hub-Signature-256'] ?? ''

  const ssmPrefix = env.SSM_PATH_PREFIX.replace(/\/$/, '')
  const appSecret = await getSsmParameter(`${ssmPrefix}/meta/app-secret`)

  if (!verifySignature(rawBody, sigHeader, appSecret)) {
    console.error('signature_invalid')
    return { statusCode: 401, body: 'Invalid signature' }
  }

  let payload: z.infer<typeof webhookPayloadSchema>
  try {
    payload = webhookPayloadSchema.parse(JSON.parse(rawBody))
  } catch (err) {
    console.error('parse_error', err)
    return { statusCode: 200, body: 'EVENT_RECEIVED' }
  }

  for (const entry of payload.entry) {
    const pageId = entry.id

    const dbAdmin = await getDbAdmin()
    const rows = await dbAdmin
      .select({
        tenantId: connectedPages.tenantId,
        id: connectedPages.id,
        pageAccessTokenEncrypted: connectedPages.pageAccessTokenEncrypted,
      })
      .from(connectedPages)
      .where(and(eq(connectedPages.pageId, pageId), eq(connectedPages.isActive, true)))

    const page = rows[0]
    if (!page) {
      console.log('unknown_page', { pageId })
      continue
    }

    for (const msgEvent of entry.messaging) {
      const result = await processMessagingEvent(msgEvent, page.tenantId, page.id, page.pageAccessTokenEncrypted)

      if (result) {
        try {
          await sqsClient.send(
            new SendMessageCommand({
              QueueUrl: env.SQS_QUEUE_URL,
              DelaySeconds: env.DRAFT_DEBOUNCE_SECONDS,
              MessageBody: JSON.stringify({
                jobType: 'draft',
                conversationId: result.conversationId,
                triggerMessageId: result.messageId,
              }),
            }),
          )
          console.info('draft_enqueued', {
            conversationId: result.conversationId,
            triggerMessageId: result.messageId,
            delaySeconds: env.DRAFT_DEBOUNCE_SECONDS,
          })
        } catch (err) {
          console.error('sqs_enqueue_failed', { conversationId: result.conversationId, err })
        }

        // Summary trigger is independent of draft SQS: fires even if draft enqueue failed,
        // since it tracks conversation char count, not AI draft generation.
        await maybeEnqueueSummaryJob(result.conversationId, page.tenantId)
      }
    }
  }

  return { statusCode: 200, body: 'EVENT_RECEIVED' }
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const method = event.requestContext.http.method
  if (method === 'GET') return handleGet(event)
  if (method === 'POST') return handlePost(event)

  return {
    statusCode: 405,
    headers: { Allow: 'GET, POST' },
    body: 'Method Not Allowed',
  }
}
