import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { createDecipheriv } from 'node:crypto'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDbAdmin } from './db/client'
import { withTenant } from './db/with-tenant'
import { aiDrafts, connectedPages, conversations, messages } from './db/schema'
import { getSsmParameter } from './services/ssm'
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
    if (!res.ok) return null
    const data = (await res.json()) as { name?: string }
    return typeof data.name === 'string' ? data.name : null
  } catch {
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

function determineMessageType(msg: z.infer<typeof messageSchema>): {
  messageType: string
  body: string
} {
  if (msg.text !== undefined) return { messageType: 'text', body: msg.text }
  const att = msg.attachments?.[0]
  if (att?.payload?.sticker_id !== undefined) return { messageType: 'sticker', body: '' }
  if (att?.type === 'image') return { messageType: 'image', body: att.payload?.url ?? '' }
  return { messageType: 'unknown', body: '' }
}

async function processMessagingEvent(
  event: MessagingEvent,
  tenantId: string,
  pageUuid: string,
  pageAccessTokenEncrypted: Buffer,
): Promise<string | null> {
  const msg = event.message
  if (!msg) return null

  const { mid, is_echo } = msg
  const ts = event.timestamp

  if (is_echo) {
    await withTenant(tenantId, async (tx) => {
      await tx
        .update(messages)
        .set({ sendStatus: 'sent' })
        .where(and(eq(messages.metaMessageId, mid), eq(messages.tenantId, tenantId)))
    })
    return null
  }

  const psid = event.sender.id
  const { messageType, body } = determineMessageType(msg)

  let convId: string | null = null
  let needsNameFetch = false

  const newMessageId = await withTenant(tenantId, async (tx) => {
    const [conv] = await tx
      .insert(conversations)
      .values({
        tenantId,
        pageId: pageUuid,
        customerPsid: psid,
      })
      .onConflictDoUpdate({
        target: [conversations.pageId, conversations.customerPsid],
        set: { customerPsid: sql`excluded.customer_psid` },
      })
      .returning({ id: conversations.id, customerName: conversations.customerName })

    if (!conv) throw new Error('Failed to upsert conversation')

    convId = conv.id
    needsNameFetch = !conv.customerName

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
      })
      .onConflictDoNothing()
      .returning({ id: messages.id })

    const newMsg = inserted[0]
    if (!newMsg) return null

    await tx
      .update(conversations)
      .set({
        lastInboundAt: new Date(ts),
        lastMessageAt: new Date(ts),
        unreadCount: sql`${conversations.unreadCount} + 1`,
      })
      .where(eq(conversations.id, conv.id))

    if (messageType !== 'text') return null

    const draftInserted = await tx
      .insert(aiDrafts)
      .values({ tenantId, messageId: newMsg.id, status: 'pending' })
      .onConflictDoNothing()
      .returning({ id: aiDrafts.id })

    return draftInserted[0] ? newMsg.id : null
  })

  // Fetch and store the sender's name only for new conversations (customerName is null).
  // Done outside the transaction to avoid holding a DB connection during the API call.
  if (needsNameFetch && convId) {
    try {
      const masterKey = await getMasterKey()
      const pageAccessToken = decryptToken(pageAccessTokenEncrypted, masterKey)
      const name = await fetchCustomerName(psid, pageAccessToken)
      if (name) {
        await withTenant(tenantId, async (tx) => {
          await tx
            .update(conversations)
            .set({ customerName: name })
            .where(eq(conversations.id, convId!))
        })
      }
    } catch (err) {
      console.error('fetch_customer_name_failed', { psid, err })
    }
  }

  return newMessageId
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
      const newMessageId = await processMessagingEvent(msgEvent, page.tenantId, page.id, page.pageAccessTokenEncrypted)

      if (newMessageId) {
        try {
          await sqsClient.send(
            new SendMessageCommand({
              QueueUrl: env.SQS_QUEUE_URL,
              MessageBody: JSON.stringify({ messageId: newMessageId }),
            }),
          )
        } catch (err) {
          console.error('sqs_enqueue_failed', { messageId: newMessageId, err })
        }
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
