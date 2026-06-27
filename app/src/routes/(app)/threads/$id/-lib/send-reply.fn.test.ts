// Set required env vars before any module imports
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
import type { TenantTx } from '~/server/db/with-tenant'

// Mock the DB client to prevent real connection attempts
vi.mock('~/server/db/client', () => ({
  db: {},
  dbAdmin: {},
}))

const META_MESSAGES_URL = 'https://graph.facebook.com/v19.0/me/messages'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => {
  server.resetHandlers()
  vi.clearAllMocks()
})
afterAll(() => server.close())

const NOW = new Date('2026-05-01T00:00:00Z').getTime()
const LAST_INBOUND_AT = new Date('2026-04-30T12:00:00Z') // 12h ago — within window
const OLD_INBOUND_AT = new Date('2026-04-29T00:00:00Z')  // 48h ago — outside window
const CONVERSATION_ID = '00000000-0000-0000-0000-000000000001'
const MESSAGE_ID = '00000000-0000-0000-0000-000000000003'
const TENANT_ID = '00000000-0000-0000-0000-000000000004'
const USER_ID = '00000000-0000-0000-0000-000000000005'

const FAKE_ENCRYPTED = Buffer.from('fake')
const DECRYPTED_TOKEN = 'page-access-token-abc'

vi.mock('~/server/services/crypto', () => ({
  getMasterKey: vi.fn().mockResolvedValue(Buffer.alloc(32)),
  decryptToken: vi.fn().mockReturnValue(DECRYPTED_TOKEN),
}))

function buildMockTx(opts: {
  lastInboundAt?: Date | null
  conversationExists?: boolean
  pageExists?: boolean
  /** 006: 1 つ目の messages.update() で UNIQUE 違反を投げる (mid 書き戻し race) */
  midWriteThrowsUnique?: boolean
  /** 006: attribute 補正で claimed 行が返す ID (デフォルトは echo 行のダミー) */
  claimedRowId?: string
}): TenantTx {
  const {
    lastInboundAt = LAST_INBOUND_AT,
    conversationExists = true,
    pageExists = true,
    midWriteThrowsUnique = false,
    claimedRowId = '00000000-0000-0000-0000-000000000099',
  } = opts

  const convRows = conversationExists
    ? [{ id: CONVERSATION_ID, customerPsid: 'psid-123', lastInboundAt }]
    : []

  const pageRows = pageExists
    ? [{ pageAccessTokenEncrypted: FAKE_ENCRYPTED }]
    : []

  const insertedRows = [
    { id: MESSAGE_ID, body: 'Hello', timestamp: new Date('2026-05-01T00:00:01Z') },
  ]

  // 006: update() builder を呼び出し順に切り替えるため stateful 化。
  // 期待される呼び出し順 (sendResult.ok 経路):
  //   1) messages: mid 書き戻し (UNIQUE 違反シミュレート対象)
  //   2) messages: claimed 行への attribute (returning() で claimed ID を返す) — UNIQUE catch 時のみ
  //   3) conversations: lastMessageAt 更新
  //   4) aiDrafts: status=dismissed
  //
  // ポイント: where() は await されるが、attribute 補正パスでは `where().returning()` と
  // チェーンされるため、where() は **thenable + .returning を持つオブジェクト** を返す必要がある。
  let updateCallCount = 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildAwaitableWithReturning = (): any => ({
    then: (resolve: (v: undefined) => void) => resolve(undefined),
    returning: vi.fn().mockResolvedValue([{ id: claimedRowId }]),
  })
  const updateBuilder = () => {
    updateCallCount++
    const callIdx = updateCallCount
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    b.set = vi.fn().mockReturnValue(b)
    if (callIdx === 1 && midWriteThrowsUnique) {
      const err = {
        code: '23505',
        constraint_name: 'messages_meta_message_id_unique',
        message: 'duplicate key value violates unique constraint',
      }
      b.where = vi.fn().mockReturnValue(Promise.reject(err))
    } else {
      b.where = vi.fn().mockReturnValue(buildAwaitableWithReturning())
    }
    return b
  }

  // delete() builder (006: UNIQUE 違反時に tentative 行を消す)
  const deleteBuilder = {
    where: vi.fn().mockResolvedValue(undefined),
  }

  let limitCallCount = 0

  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockImplementation(() => {
      limitCallCount++
      if (limitCallCount === 1) return Promise.resolve(convRows)
      return Promise.resolve(pageRows)
    }),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(insertedRows),
    update: vi.fn().mockImplementation(updateBuilder),
    delete: vi.fn().mockReturnValue(deleteBuilder),
  } as unknown as TenantTx
}

describe('handleSendReply', () => {
  beforeAll(() => {
    // Spy only on Date.now() — do NOT replace setTimeout (would freeze sleep/retry backoff)
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
  })

  afterAll(() => {
    vi.restoreAllMocks()
  })

  it('succeeds: sends message and returns ok=true with sent status', async () => {
    server.use(
      http.post(META_MESSAGES_URL, () =>
        HttpResponse.json({ recipient_id: 'psid-123', message_id: 'm_sent123' }),
      ),
    )

    const tx = buildMockTx({})
    const { handleSendReply } = await import('./send-reply.server')
    const result = await handleSendReply(tx, TENANT_ID, USER_ID, {
      conversationId: CONVERSATION_ID,
      body: 'Hello',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.message.send_status).toBe('sent')
      expect(result.message.body).toBe('Hello')
    }
  })

  it('returns outside_window when 24h has passed since last inbound', async () => {
    const tx = buildMockTx({ lastInboundAt: OLD_INBOUND_AT })
    const { handleSendReply } = await import('./send-reply.server')
    const result = await handleSendReply(tx, TENANT_ID, USER_ID, {
      conversationId: CONVERSATION_ID,
      body: 'Hello',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('outside_window')
  })

  it('returns token_expired when Meta returns OAuth error code 190', async () => {
    server.use(
      http.post(META_MESSAGES_URL, () =>
        HttpResponse.json(
          { error: { message: 'Invalid OAuth 2.0 Access Token', type: 'OAuthException', code: 190, fbtrace_id: 'x' } },
          { status: 400 },
        ),
      ),
    )

    const tx = buildMockTx({})
    const { handleSendReply } = await import('./send-reply.server')
    const result = await handleSendReply(tx, TENANT_ID, USER_ID, {
      conversationId: CONVERSATION_ID,
      body: 'Hello',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('token_expired')
  })

  // 006: T015 — echo 先着 → mid 書き戻しで UNIQUE 違反 → attribute 補正経路
  it('T015: echo race → UNIQUE catch で attribute 補正し finalMessageId が echo 行 ID に置換', async () => {
    server.use(
      http.post(META_MESSAGES_URL, () =>
        HttpResponse.json({ recipient_id: 'psid-123', message_id: 'm_race_001' }),
      ),
    )

    const ECHO_ROW_ID = '00000000-0000-0000-0000-0000000000ec'
    const tx = buildMockTx({ midWriteThrowsUnique: true, claimedRowId: ECHO_ROW_ID })
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    const { handleSendReply } = await import('./send-reply.server')
    const result = await handleSendReply(tx, TENANT_ID, USER_ID, {
      conversationId: CONVERSATION_ID,
      body: 'Hello',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      // tentative 行は DELETE され、戻り値の id は echo 行に置き換わる
      expect(result.message.id).toBe(ECHO_ROW_ID)
      expect(result.message.send_status).toBe('sent')
    }
    // delete + attribute UPDATE が呼ばれた
    expect((tx.delete as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(0)
    // 構造化ログ
    const attrLog = infoSpy.mock.calls.find((c) => c[0] === 'echo_send_attribution_recovered')
    expect(attrLog).toBeDefined()
    expect(attrLog![1]).toMatchObject({
      conversationId: CONVERSATION_ID,
      mid: 'm_race_001',
      droppedRowId: MESSAGE_ID,
      sentByAuthUid: USER_ID,
    })
    infoSpy.mockRestore()
  })

  it(
    'returns meta_error after exhausting Meta 5xx retries',
    async () => {
      // messenger.ts retries 3× with exponential backoff (0ms + 500ms + 1500ms ≈ 2s total)
      server.use(
        http.post(META_MESSAGES_URL, () =>
          HttpResponse.json({ error: 'Server error' }, { status: 500 }),
        ),
      )

      const tx = buildMockTx({})
      const { handleSendReply } = await import('./send-reply.server')
      const result = await handleSendReply(tx, TENANT_ID, USER_ID, {
        conversationId: CONVERSATION_ID,
        body: 'Hello',
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('meta_error')
    },
    10_000, // allow time for 3 retry backoff cycles
  )
})
