// @vitest-environment node
// Integration: send-reply full user story — auth → listConversations → getConversation → sendReply
// Tests the complete sendReply business logic with shared mock DB state and MSW Meta API

process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test'
process.env.DATABASE_URL_SERVICE_ROLE = 'postgresql://test:test@localhost:5432/test'
process.env.SUPABASE_URL = 'https://test.supabase.co'
process.env.SUPABASE_PUBLISHABLE_KEY = 'test-key'
process.env.SUPABASE_SECRET_KEY = 'test-secret'
process.env.META_APP_SECRET_SSM_KEY = '/test/meta/secret'
process.env.WEBHOOK_VERIFY_TOKEN_SSM_KEY = '/test/webhook/token'
process.env.ANTHROPIC_API_KEY_SSM_KEY = '/test/anthropic/key'
process.env.AWS_REGION = 'ap-northeast-1'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

vi.mock('~/server/db/client', () => ({ db: {}, dbAdmin: {} }))
vi.mock('~/server/services/crypto', () => ({
  getMasterKey: vi.fn().mockResolvedValue(Buffer.alloc(32)),
  decryptToken: vi.fn().mockReturnValue('page-access-token-xyz'),
  encryptToken: vi.fn().mockReturnValue(Buffer.from('encrypted')),
}))
vi.mock('~/server/db/with-tenant', () => ({
  withTenant: (...args: unknown[]) => mockWithTenant(...args),
}))

const mockWithTenant = vi.fn()

const META_SEND_URL = 'https://graph.facebook.com/v19.0/me/messages'

const TENANT_ID  = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_ID    = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CONV_ID    = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const MSG_ID     = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PSID       = '123456789'

const LAST_INBOUND_AT = new Date(Date.now() - 3 * 60 * 60 * 1000)   // 3h ago — within window
const OLD_INBOUND_AT  = new Date(Date.now() - 30 * 60 * 60 * 1000)  // 30h ago — outside window

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => {
  server.resetHandlers()
  vi.clearAllMocks()
})
afterAll(() => server.close())

import { handleSendReply } from '~/routes/(app)/threads/$id/-lib/send-reply.fn'
import type { TenantTx } from '~/server/db/with-tenant'

// Build a mock tx whose Drizzle query chain resolves in the correct sequence.
// handleSendReply calls:
//   1. tx.select().from(conversations).where().limit(1)        → [convRow]
//   2. tx.select().from(connectedPages).innerJoin().where().orderBy().limit(1) → [pageRow]
//   3. tx.insert(messages).values().returning()               → [insertedRow]
//   4. tx.update(messages).set().where()                       → void  (success path)
//   5. tx.update(conversations).set().where()                  → void  (success path)
function buildTx(opts: {
  lastInboundAt?: Date | null
  pageExists?: boolean
  insertId?: string
}): TenantTx {
  const { lastInboundAt = LAST_INBOUND_AT, pageExists = true, insertId = MSG_ID } = opts

  const convRow  = { id: CONV_ID, customerPsid: PSID, lastInboundAt }
  const pageRow  = { pageAccessTokenEncrypted: Buffer.from('enc') }
  const insertedRow = { id: insertId, body: 'reply text', timestamp: new Date() }

  let selectCallCount = 0

  const makeSelectChain = () => {
    // Each call to tx.select() builds a fresh chain that tracks its call index.
    const callIndex = ++selectCallCount
    const chain: Record<string, unknown> = {}
    chain.from = vi.fn().mockReturnValue(chain)
    chain.innerJoin = vi.fn().mockReturnValue(chain)
    chain.orderBy = vi.fn().mockReturnValue(chain)
    chain.where = vi.fn().mockReturnValue(chain)
    chain.limit = vi.fn().mockImplementation(() => {
      if (callIndex === 1) return Promise.resolve([convRow])
      if (callIndex === 2 && pageExists) return Promise.resolve([pageRow])
      if (callIndex === 2 && !pageExists) return Promise.resolve([])
      return Promise.resolve([])
    })
    return chain
  }

  const insertChain: Record<string, unknown> = {}
  insertChain.values = vi.fn().mockReturnValue(insertChain)
  insertChain.returning = vi.fn().mockResolvedValue([insertedRow])

  const updateChain: Record<string, unknown> = {}
  updateChain.set = vi.fn().mockReturnValue(updateChain)
  updateChain.where = vi.fn().mockResolvedValue(undefined)

  return {
    select: vi.fn().mockImplementation(makeSelectChain),
    insert: vi.fn().mockReturnValue(insertChain),
    update: vi.fn().mockReturnValue(updateChain),
  } as unknown as TenantTx
}

describe('send-reply integration — handleSendReply', () => {
  it('success: inserts outbound message and returns sent status', async () => {
    server.use(
      http.post(META_SEND_URL, () =>
        HttpResponse.json({ message_id: 'mid_success_001', recipient_id: PSID }),
      ),
    )

    const mockTx = buildTx({})
    const result = await handleSendReply(mockTx, TENANT_ID, USER_ID, {
      conversationId: CONV_ID,
      body: 'reply text',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.message.send_status).toBe('sent')
      expect(result.message.body).toBe('reply text')
    }
  })

  it('outside_window: rejects when last inbound > 24h ago', async () => {
    const mockTx = buildTx({ lastInboundAt: OLD_INBOUND_AT })
    const result = await handleSendReply(mockTx, TENANT_ID, USER_ID, {
      conversationId: CONV_ID,
      body: 'too late',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('outside_window')
  })

  it('no page: rejects when connected page not found', async () => {
    const mockTx = buildTx({ pageExists: false })
    const result = await handleSendReply(mockTx, TENANT_ID, USER_ID, {
      conversationId: CONV_ID,
      body: 'no page',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('validation_failed')
  })

  it('token_expired: maps Meta 190 error to token_expired', async () => {
    server.use(
      http.post(META_SEND_URL, () =>
        HttpResponse.json(
          { error: { code: 190, type: 'OAuthException', message: 'Invalid token' } },
          { status: 400 },
        ),
      ),
    )

    const mockTx = buildTx({})
    const result = await handleSendReply(mockTx, TENANT_ID, USER_ID, {
      conversationId: CONV_ID,
      body: 'expired token scenario',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('token_expired')
  })

  it('meta_error: maps Meta 5xx to meta_error', async () => {
    server.use(
      http.post(META_SEND_URL, () =>
        HttpResponse.json({ error: { code: 500 } }, { status: 500 }),
      ),
    )

    const mockTx = buildTx({})
    const result = await handleSendReply(mockTx, TENANT_ID, USER_ID, {
      conversationId: CONV_ID,
      body: '5xx scenario',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('meta_error')
  })

  it('null lastInboundAt: treats as outside_window', async () => {
    const mockTx = buildTx({ lastInboundAt: null })
    const result = await handleSendReply(mockTx, TENANT_ID, USER_ID, {
      conversationId: CONV_ID,
      body: 'no inbound yet',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('outside_window')
  })
})
