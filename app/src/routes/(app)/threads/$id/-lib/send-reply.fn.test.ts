// Set required env vars before any module imports
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test'
process.env.DATABASE_URL_SERVICE_ROLE = 'postgresql://test:test@localhost:5432/test'
process.env.SUPABASE_URL = 'https://test.supabase.co'
process.env.SUPABASE_PUBLISHABLE_KEY = 'test-key'
process.env.SUPABASE_SECRET_KEY = 'test-secret'
process.env.META_APP_SECRET_SSM_KEY = '/test/meta/secret'
process.env.WEBHOOK_VERIFY_TOKEN_SSM_KEY = '/test/webhook/token'
process.env.ANTHROPIC_API_KEY_SSM_KEY = '/test/anthropic/key'
process.env.META_APP_ID = 'test-app-id'
process.env.AWS_REGION = 'ap-northeast-1'
process.env.MEDIA_BUCKET_NAME = 'test-media-bucket'

import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
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

const s3Mock = mockClient(S3Client)

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => {
  server.resetHandlers()
  vi.clearAllMocks()
  s3Mock.reset()
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

// 010: presigned GET URL 発行をモック。既定は URL を返し、null 経路 (presign 不能) を個別に検証する。
const { mockGetAttachmentUrl } = vi.hoisted(() => ({
  mockGetAttachmentUrl: vi.fn(async (_key: string) => 'https://signed.example/get'),
}))
vi.mock('~/server/services/media-url', () => ({ getAttachmentUrl: mockGetAttachmentUrl }))

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
    // 構造化ログ ({ event: '...', ... } 形式 — codebase convention に揃える)
    const attrLog = infoSpy.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === 'echo_send_attribution_recovered',
    )
    expect(attrLog).toBeDefined()
    expect(attrLog![0]).toMatchObject({
      event: 'echo_send_attribution_recovered',
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

// 010: attachment パス (US1 画像単独送信)
describe('handleSendReply — attachment', () => {
  const VALID_KEY = `${TENANT_ID}/${CONVERSATION_ID}/outbound/11111111-1111-4111-8111-111111111111/0`

  beforeAll(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
  })
  afterAll(() => vi.restoreAllMocks())

  function captureInsertValues(tx: TenantTx): Record<string, unknown>[] {
    const valuesFn = (tx as unknown as { values: { mock: { calls: unknown[][] } } }).values
    return valuesFn.mock.calls.map((c) => c[0] as Record<string, unknown>)
  }

  it('画像単独送信: messageType=image / body="" / attachments を INSERT し image ペイロードで送信', async () => {
    s3Mock.on(HeadObjectCommand).resolves({ ContentType: 'image/jpeg', ContentLength: 1234 })
    let sentBody: unknown
    server.use(
      http.post(META_MESSAGES_URL, async ({ request }) => {
        sentBody = await request.json()
        return HttpResponse.json({ recipient_id: 'psid-123', message_id: 'm_img_1' })
      }),
    )

    const tx = buildMockTx({})
    const { handleSendReply } = await import('./send-reply.server')
    const result = await handleSendReply(tx, TENANT_ID, USER_ID, {
      conversationId: CONVERSATION_ID,
      body: '',
      attachment: { s3Key: VALID_KEY },
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.parts).toEqual([{ kind: 'image', ok: true, error: undefined }])
      expect(result.message.send_status).toBe('sent')
    }
    // INSERT された行が image メタを持つ
    const inserts = captureInsertValues(tx)
    const imageInsert = inserts.find((v) => v.messageType === 'image')
    expect(imageInsert).toBeDefined()
    expect(imageInsert!.body).toBe('')
    expect(imageInsert!.attachments).toEqual([
      { index: 0, type: 'image', s3Key: VALID_KEY, contentType: 'image/jpeg', sizeBytes: 1234 },
    ])
    // Meta へ画像 attachment ペイロード
    expect(sentBody).toMatchObject({ message: { attachment: { type: 'image' } } })
  })

  it('不正な s3Key (他会話) は送信前に validation_failed + key_rejected ログ', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const otherConvKey = `${TENANT_ID}/00000000-0000-0000-0000-0000000000ee/outbound/11111111-1111-4111-8111-111111111111/0`

    const tx = buildMockTx({})
    const { handleSendReply } = await import('./send-reply.server')
    const result = await handleSendReply(tx, TENANT_ID, USER_ID, {
      conversationId: CONVERSATION_ID,
      body: '',
      attachment: { s3Key: otherConvKey },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('validation_failed')
    const rejected = warnSpy.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === 'outbound_attachment_key_rejected',
    )
    expect(rejected).toBeDefined()
    // 送信前に弾くので Meta も INSERT も走らない
    expect(captureInsertValues(tx)).toHaveLength(0)
    warnSpy.mockRestore()
  })

  it('HeadObject が存在しない (アップロード未完了) → validation_failed', async () => {
    s3Mock.on(HeadObjectCommand).rejects(Object.assign(new Error('Not Found'), { name: 'NotFound' }))

    const tx = buildMockTx({})
    const { handleSendReply } = await import('./send-reply.server')
    const result = await handleSendReply(tx, TENANT_ID, USER_ID, {
      conversationId: CONVERSATION_ID,
      body: '',
      attachment: { s3Key: VALID_KEY },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('validation_failed')
    expect(captureInsertValues(tx)).toHaveLength(0)
  })

  it('HeadObject の型が allowlist 外 → validation_failed + head_validation_failed ログ', async () => {
    s3Mock.on(HeadObjectCommand).resolves({ ContentType: 'application/pdf', ContentLength: 100 })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const tx = buildMockTx({})
    const { handleSendReply } = await import('./send-reply.server')
    const result = await handleSendReply(tx, TENANT_ID, USER_ID, {
      conversationId: CONVERSATION_ID,
      body: '',
      attachment: { s3Key: VALID_KEY },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('validation_failed')
    const log = warnSpy.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === 'outbound_attachment_send_failed',
    )
    expect(log![0]).toMatchObject({ reason: 'head_validation_failed', s3Key: VALID_KEY })
    warnSpy.mockRestore()
  })

  it('presign 不能 (getAttachmentUrl=null) は Meta を呼ばず meta_error で失敗', async () => {
    s3Mock.on(HeadObjectCommand).resolves({ ContentType: 'image/jpeg', ContentLength: 400 })
    mockGetAttachmentUrl.mockResolvedValueOnce(null as unknown as string)
    let metaCalled = false
    server.use(
      http.post(META_MESSAGES_URL, () => {
        metaCalled = true
        return HttpResponse.json({ message_id: 'x' })
      }),
    )

    const tx = buildMockTx({})
    const { handleSendReply } = await import('./send-reply.server')
    const result = await handleSendReply(tx, TENANT_ID, USER_ID, {
      conversationId: CONVERSATION_ID,
      body: '',
      attachment: { s3Key: VALID_KEY },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('meta_error')
    expect(metaCalled).toBe(false)
  })

  // T022: サーバー側の拒否経路の回帰
  it('T022: 他テナントの s3Key 持ち込みを拒否し key_rejected を出す (FR-010)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const otherTenantKey = `00000000-0000-0000-0000-0000000000ff/${CONVERSATION_ID}/outbound/11111111-1111-4111-8111-111111111111/0`

    const tx = buildMockTx({})
    const { handleSendReply } = await import('./send-reply.server')
    const result = await handleSendReply(tx, TENANT_ID, USER_ID, {
      conversationId: CONVERSATION_ID,
      body: '',
      attachment: { s3Key: otherTenantKey },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('validation_failed')
    expect(
      warnSpy.mock.calls.some((c) => (c[0] as { event?: string })?.event === 'outbound_attachment_key_rejected'),
    ).toBe(true)
    warnSpy.mockRestore()
  })

  it('T022: client 検証を迂回した過大サイズ (Head ContentLength > MAX) をサーバーが拒否', async () => {
    s3Mock.on(HeadObjectCommand).resolves({ ContentType: 'image/jpeg', ContentLength: 26_214_400 + 1 })

    const tx = buildMockTx({})
    const { handleSendReply } = await import('./send-reply.server')
    const result = await handleSendReply(tx, TENANT_ID, USER_ID, {
      conversationId: CONVERSATION_ID,
      body: '',
      attachment: { s3Key: VALID_KEY },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('validation_failed')
  })

  it('T022: フォームを開いたまま期限切れ (attachment 付き) → outside_window', async () => {
    s3Mock.on(HeadObjectCommand).resolves({ ContentType: 'image/jpeg', ContentLength: 100 })
    const OLD = new Date('2026-04-29T00:00:00Z') // 48h ago
    const tx = buildMockTx({ lastInboundAt: OLD })
    const { handleSendReply } = await import('./send-reply.server')
    const result = await handleSendReply(tx, TENANT_ID, USER_ID, {
      conversationId: CONVERSATION_ID,
      body: 'still here',
      attachment: { s3Key: VALID_KEY },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('outside_window')
  })

  // T024: 画像送信失敗時に outbound_attachment_send_failed が reason 付き event JSON で出る
  it('T024: image 送信失敗で outbound_attachment_send_failed (reason=meta_error) を warn ログ', async () => {
    s3Mock.on(HeadObjectCommand).resolves({ ContentType: 'image/jpeg', ContentLength: 300 })
    server.use(
      http.post(META_MESSAGES_URL, () => HttpResponse.json({ error: { code: 100 } }, { status: 400 })),
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const tx = buildMockTx({})
    const { handleSendReply } = await import('./send-reply.server')
    const result = await handleSendReply(tx, TENANT_ID, USER_ID, {
      conversationId: CONVERSATION_ID,
      body: '',
      attachment: { s3Key: VALID_KEY },
    })

    expect(result.ok).toBe(false)
    const log = warnSpy.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === 'outbound_attachment_send_failed',
    )
    expect(log).toBeDefined()
    expect(log![0]).toMatchObject({
      event: 'outbound_attachment_send_failed',
      tenantId: TENANT_ID,
      conversationId: CONVERSATION_ID,
      s3Key: VALID_KEY,
      reason: 'meta_error',
    })
    warnSpy.mockRestore()
  })

  it('echo claim が image パーツでも働く (mid UNIQUE 衝突)', async () => {
    s3Mock.on(HeadObjectCommand).resolves({ ContentType: 'image/png', ContentLength: 500 })
    server.use(
      http.post(META_MESSAGES_URL, () =>
        HttpResponse.json({ recipient_id: 'psid-123', message_id: 'm_img_echo' }),
      ),
    )
    const ECHO_ROW_ID = '00000000-0000-0000-0000-0000000000ec'
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    const tx = buildMockTx({ midWriteThrowsUnique: true, claimedRowId: ECHO_ROW_ID })
    const { handleSendReply } = await import('./send-reply.server')
    const result = await handleSendReply(tx, TENANT_ID, USER_ID, {
      conversationId: CONVERSATION_ID,
      body: '',
      attachment: { s3Key: VALID_KEY },
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.message.id).toBe(ECHO_ROW_ID)
    const attrLog = infoSpy.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === 'echo_send_attribution_recovered',
    )
    expect(attrLog).toBeDefined()
    infoSpy.mockRestore()
  })
})
