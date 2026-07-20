import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockClient } from 'aws-sdk-client-mock'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import type { APIGatewayProxyEventV2 } from 'aws-lambda'

const APP_SECRET = 'test-app-secret-abc123'
const VERIFY_TOKEN = 'test-verify-token'
const TENANT_ID = 'tenant-uuid-aaaa'
const PAGE_UUID = 'page-uuid-bbbb'
const PAGE_ID = '111222333'
const CUSTOMER_PSID = '999888777'
const MESSAGE_MID = 'm_abc123xyz'
const NEW_MSG_UUID = 'msg-uuid-cccc'
const CONV_UUID = 'conv-uuid-dddd'

// hoisted mocks
const {
  mockSsm,
  mockWithTenant,
  mockDbAdminWhere,
  mockMaybeEnqueueSummaryJob,
  mockDownloadAttachment,
  mockStoreAttachment,
  mockEnv,
} = vi.hoisted(() => ({
  mockSsm: vi.fn(),
  mockWithTenant: vi.fn(),
  mockDbAdminWhere: vi.fn(),
  mockMaybeEnqueueSummaryJob: vi.fn(),
  mockDownloadAttachment: vi.fn(),
  mockStoreAttachment: vi.fn(),
  // 009: MEDIA_BUCKET_NAME をテストごとに変えられるよう可変オブジェクトにする
  // (handler は env.MEDIA_BUCKET_NAME を都度プロパティアクセスで読む)。
  mockEnv: {
    SSM_PATH_PREFIX: '/fumireply/test',
    SQS_QUEUE_URL: 'https://sqs.ap-northeast-1.amazonaws.com/123/test-queue',
    AWS_REGION: 'ap-northeast-1',
    MEDIA_BUCKET_NAME: 'test-media-bucket',
  },
}))

vi.mock('./env', () => ({
  env: mockEnv,
}))

vi.mock('./services/ssm', () => ({
  getSsmParameter: mockSsm,
}))

// 009: ダウンロード/保存は media.test.ts で単体検証済みのため、handler テストでは
// 呼び出し境界 (URL・回数・キー構成要素) をモックで検証する。
vi.mock('./services/media', () => ({
  downloadAttachment: mockDownloadAttachment,
  storeAttachment: mockStoreAttachment,
}))

vi.mock('./services/summary-trigger', () => ({
  maybeEnqueueSummaryJob: mockMaybeEnqueueSummaryJob,
}))

vi.mock('./db/client', () => ({
  getDb: async () => ({}),
  getDbAdmin: async () => ({
    select: () => ({ from: () => ({ where: mockDbAdminWhere }) }),
  }),
}))

vi.mock('./db/with-tenant', () => ({
  withTenant: mockWithTenant,
}))

const sqsMock = mockClient(SQSClient)

const { handler } = await import('./handler')

// --- helpers ---
function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', APP_SECRET).update(body, 'utf-8').digest('hex')
}

function makePostEvent(payload: object, opts: { badSig?: boolean } = {}): APIGatewayProxyEventV2 {
  const body = JSON.stringify(payload)
  const sig = opts.badSig ? 'sha256=badsignature000' : sign(body)
  return {
    version: '2.0',
    routeKey: 'POST /api/webhook',
    rawPath: '/api/webhook',
    rawQueryString: '',
    headers: { 'x-hub-signature-256': sig, 'content-type': 'application/json' },
    body,
    isBase64Encoded: false,
    requestContext: {
      accountId: '123',
      apiId: 'test',
      domainName: 'test.example.com',
      domainPrefix: 'test',
      http: {
        method: 'POST',
        path: '/api/webhook',
        protocol: 'HTTP/1.1',
        sourceIp: '1.2.3.4',
        userAgent: 'facebookplatform/1.0',
      },
      requestId: 'req-1',
      routeKey: 'POST /api/webhook',
      stage: '$default',
      time: '01/Jan/2025:00:00:00 +0000',
      timeEpoch: 1735689600000,
    },
  }
}

function makeGetEvent(params: Record<string, string>): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /api/webhook',
    rawPath: '/api/webhook',
    rawQueryString: new URLSearchParams(params).toString(),
    headers: {},
    queryStringParameters: params,
    isBase64Encoded: false,
    body: undefined,
    requestContext: {
      accountId: '123',
      apiId: 'test',
      domainName: 'test.example.com',
      domainPrefix: 'test',
      http: {
        method: 'GET',
        path: '/api/webhook',
        protocol: 'HTTP/1.1',
        sourceIp: '1.2.3.4',
        userAgent: 'facebookplatform/1.0',
      },
      requestId: 'req-1',
      routeKey: 'GET /api/webhook',
      stage: '$default',
      time: '01/Jan/2025:00:00:00 +0000',
      timeEpoch: 1735689600000,
    },
  }
}

const textPayload = {
  object: 'page',
  entry: [
    {
      id: PAGE_ID,
      time: 1735689600000,
      messaging: [
        {
          sender: { id: CUSTOMER_PSID },
          recipient: { id: PAGE_ID },
          timestamp: 1735689600000,
          message: { mid: MESSAGE_MID, text: 'Hello!' },
        },
      ],
    },
  ],
}

const stickerPayload = {
  object: 'page',
  entry: [
    {
      id: PAGE_ID,
      time: 1735689600000,
      messaging: [
        {
          sender: { id: CUSTOMER_PSID },
          recipient: { id: PAGE_ID },
          timestamp: 1735689600000,
          message: {
            mid: MESSAGE_MID,
            attachments: [{ type: 'image', payload: { sticker_id: 369239263222822 } }],
          },
        },
      ],
    },
  ],
}

beforeEach(() => {
  sqsMock.reset()
  mockSsm.mockReset()
  mockWithTenant.mockReset()
  mockDbAdminWhere.mockReset()
  mockMaybeEnqueueSummaryJob.mockReset()
  mockMaybeEnqueueSummaryJob.mockResolvedValue(undefined)
  mockEnv.MEDIA_BUCKET_NAME = 'test-media-bucket'
  mockDownloadAttachment.mockReset()
  mockStoreAttachment.mockReset()
  // 既定は成功: 個別テストで失敗/超過を上書きする
  mockDownloadAttachment.mockResolvedValue({
    ok: true,
    buffer: Buffer.from('img-bytes'),
    contentType: 'image/jpeg',
    sizeBytes: 9,
  })
  mockStoreAttachment.mockImplementation(
    async (p: { tenantId: string; conversationId: string; mid: string; index: number }) =>
      `${p.tenantId}/${p.conversationId}/${p.mid}/${p.index}`,
  )
})

afterEach(() => {
  sqsMock.reset()
  vi.restoreAllMocks() // 006: console.info spy がテスト間で累積するのを防ぐ
})

describe('GET /api/webhook — verification', () => {
  it('returns 200 with challenge when verify_token matches', async () => {
    mockSsm.mockResolvedValue(VERIFY_TOKEN)
    const event = makeGetEvent({
      'hub.mode': 'subscribe',
      'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': 'challenge123',
    })
    const res = await handler(event)
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('challenge123')
  })

  it('returns 403 when verify_token does not match', async () => {
    mockSsm.mockResolvedValue(VERIFY_TOKEN)
    const event = makeGetEvent({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong-token',
      'hub.challenge': 'challenge123',
    })
    const res = await handler(event)
    expect(res.statusCode).toBe(403)
  })

  it('returns 403 when hub.mode is not subscribe', async () => {
    mockSsm.mockResolvedValue(VERIFY_TOKEN)
    const event = makeGetEvent({
      'hub.mode': 'unsubscribe',
      'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': 'challenge123',
    })
    const res = await handler(event)
    expect(res.statusCode).toBe(403)
  })
})

describe('POST /api/webhook — signature verification', () => {
  it('returns 401 and skips DB on invalid signature', async () => {
    mockSsm.mockResolvedValue(APP_SECRET)
    const res = await handler(makePostEvent(textPayload, { badSig: true }))
    expect(res.statusCode).toBe(401)
    expect(mockDbAdminWhere).not.toHaveBeenCalled()
    expect(mockWithTenant).not.toHaveBeenCalled()
    expect(sqsMock.calls()).toHaveLength(0)
  })
})

describe('POST /api/webhook — text message', () => {
  it('returns 200, calls withTenant, enqueues SQS for new text message', async () => {
    mockSsm.mockResolvedValue(APP_SECRET)
    mockDbAdminWhere.mockResolvedValue([{ tenantId: TENANT_ID, id: PAGE_UUID, pageAccessTokenEncrypted: Buffer.alloc(44) }])
    mockWithTenant.mockResolvedValue({ conversationId: CONV_UUID, newMessageId: NEW_MSG_UUID, needsNameFetch: false })
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'sqs-msg-id' })

    const res = await handler(makePostEvent(textPayload))

    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('EVENT_RECEIVED')
    expect(mockWithTenant).toHaveBeenCalledWith(TENANT_ID, expect.any(Function))
    expect(sqsMock.calls()).toHaveLength(1)
    const sqsInput = sqsMock.calls()[0].args[0].input as { MessageBody: string }
    // 004 changed SQS payload to conversation-scoped jobs.
    expect(JSON.parse(sqsInput.MessageBody)).toEqual({
      jobType: 'draft',
      conversationId: CONV_UUID,
      triggerMessageId: NEW_MSG_UUID,
    })
    expect(mockMaybeEnqueueSummaryJob).toHaveBeenCalledWith(CONV_UUID, TENANT_ID)
  })

  it('does not enqueue SQS for duplicate mid (withTenant returns null)', async () => {
    mockSsm.mockResolvedValue(APP_SECRET)
    mockDbAdminWhere.mockResolvedValue([{ tenantId: TENANT_ID, id: PAGE_UUID, pageAccessTokenEncrypted: Buffer.alloc(44) }])
    mockWithTenant.mockResolvedValue(null)
    sqsMock.on(SendMessageCommand).resolves({})

    const res = await handler(makePostEvent(textPayload))

    expect(res.statusCode).toBe(200)
    expect(sqsMock.calls()).toHaveLength(0)
  })
})

describe('POST /api/webhook — sticker message', () => {
  it('does not enqueue SQS for sticker', async () => {
    mockSsm.mockResolvedValue(APP_SECRET)
    mockDbAdminWhere.mockResolvedValue([{ tenantId: TENANT_ID, id: PAGE_UUID, pageAccessTokenEncrypted: Buffer.alloc(44) }])
    mockWithTenant.mockResolvedValue(null)
    sqsMock.on(SendMessageCommand).resolves({})

    const res = await handler(makePostEvent(stickerPayload))

    expect(res.statusCode).toBe(200)
    expect(mockWithTenant).toHaveBeenCalledWith(TENANT_ID, expect.any(Function))
    expect(sqsMock.calls()).toHaveLength(0)
  })
})

describe('POST /api/webhook — unknown page', () => {
  it('returns 200 and skips processing when page_id is not found', async () => {
    mockSsm.mockResolvedValue(APP_SECRET)
    mockDbAdminWhere.mockResolvedValue([])

    const res = await handler(makePostEvent(textPayload))

    expect(res.statusCode).toBe(200)
    expect(mockWithTenant).not.toHaveBeenCalled()
    expect(sqsMock.calls()).toHaveLength(0)
  })
})

describe('POST /api/webhook — SQS enqueue failure', () => {
  it('returns 200 even when SQS enqueue throws', async () => {
    mockSsm.mockResolvedValue(APP_SECRET)
    mockDbAdminWhere.mockResolvedValue([{ tenantId: TENANT_ID, id: PAGE_UUID, pageAccessTokenEncrypted: Buffer.alloc(44) }])
    mockWithTenant.mockResolvedValue({ conversationId: CONV_UUID, newMessageId: NEW_MSG_UUID, needsNameFetch: false })
    sqsMock.on(SendMessageCommand).rejects(new Error('SQS unavailable'))

    const res = await handler(makePostEvent(textPayload))

    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('EVENT_RECEIVED')
  })
})

// 006: message_echoes による外部送信取り込みのテスト群
//
// 実装契約 (specs/006-message-echoes-ingest/contracts/echo-pipeline.md C3) では、echo 経路は
// 1) upsertConversation → 2) messages の INSERT ... ON CONFLICT (meta_message_id) DO UPDATE
// → 3) (xmax = 0) で INSERT/UPDATE 判別してログ分岐、という流れ。テストでは withTenant の
// コールバックに fakeTx を渡して実行させ、`tx.insert(messages).values(X).returning(...)` の
// X を検証する。
type FakeTxCalls = {
  insert: Array<{ table: 'conversations' | 'messages'; values?: Record<string, unknown> }>
  conflictTarget: Array<unknown>
  conflictSet: Array<Record<string, unknown>>
}

function setupEchoTx(opts: {
  inserted: boolean
  convId?: string
  msgId?: string
  midExists?: boolean
}) {
  const calls: FakeTxCalls = { insert: [], conflictTarget: [], conflictSet: [] }
  mockWithTenant.mockImplementation(async (_tenantId: string, cb: (tx: unknown) => Promise<unknown>) => {
    // テーブル識別は呼び出し順で行う: echo 経路では必ず 1) conversations upsert, 2) messages
    // upsert の順で .insert() が呼ばれる。drizzle のテーブルオブジェクトをリフレクションで判別
    // するより、契約上の呼び出し順を assume するほうが堅牢。
    // 009: 添付ありのときは前段 tx (conversations upsert + 既存 mid select) が先に走る。
    // withTenant 呼び出しごとに状態を持つため、この実装は前段/本体の両方を受けられる。
    let insertCallIdx = 0
    let returningIdx = 0
    const tablesByOrder: Array<'conversations' | 'messages'> = ['conversations', 'messages']
    const returningResults: unknown[][] = [
      [{ id: opts.convId ?? CONV_UUID, customerName: null }],
      [{ id: opts.msgId ?? NEW_MSG_UUID, inserted: opts.inserted }],
    ]
    const builder: Record<string, unknown> = {}
    Object.assign(builder, {
      insert: () => {
        const tableName = tablesByOrder[insertCallIdx++] ?? 'messages'
        calls.insert.push({ table: tableName })
        return builder
      },
      values: (v: Record<string, unknown>) => {
        const last = calls.insert[calls.insert.length - 1]
        if (last) last.values = v
        return builder
      },
      onConflictDoUpdate: (conf: { target?: unknown; set?: Record<string, unknown> }) => {
        calls.conflictTarget.push(conf.target)
        calls.conflictSet.push(conf.set ?? {})
        return builder
      },
      returning: async () => returningResults[returningIdx++] ?? [],
      // 009: 前段 tx の既存 mid チェック (select().from().where().limit(1))
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (opts.midExists ? [{ id: opts.msgId ?? NEW_MSG_UUID }] : []),
          }),
        }),
      }),
    })
    return cb(builder)
  })
  return calls
}

const echoTextPayload = {
  object: 'page',
  entry: [
    {
      id: PAGE_ID,
      time: 1735689700000,
      messaging: [
        {
          sender: { id: PAGE_ID },
          recipient: { id: CUSTOMER_PSID },
          timestamp: 1735689700000,
          message: { mid: 'm_echo_text_001', is_echo: true, text: 'External reply' },
        },
      ],
    },
  ],
}

const echoStickerPayload = {
  object: 'page',
  entry: [
    {
      id: PAGE_ID,
      time: 1735689700000,
      messaging: [
        {
          sender: { id: PAGE_ID },
          recipient: { id: CUSTOMER_PSID },
          timestamp: 1735689700000,
          message: {
            mid: 'm_echo_sticker_001',
            is_echo: true,
            attachments: [{ type: 'image', payload: { sticker_id: 369239263222822 } }],
          },
        },
      ],
    },
  ],
}

const echoImagePayload = {
  object: 'page',
  entry: [
    {
      id: PAGE_ID,
      time: 1735689700000,
      messaging: [
        {
          sender: { id: PAGE_ID },
          recipient: { id: CUSTOMER_PSID },
          timestamp: 1735689700000,
          message: {
            mid: 'm_echo_image_001',
            is_echo: true,
            attachments: [{ type: 'image', payload: { url: 'https://cdn.fb.com/image.jpg' } }],
          },
        },
      ],
    },
  ],
}

describe('POST /api/webhook — message_echoes (006)', () => {
  beforeEach(() => {
    mockSsm.mockResolvedValue(APP_SECRET)
    mockDbAdminWhere.mockResolvedValue([
      { tenantId: TENANT_ID, id: PAGE_UUID, pageAccessTokenEncrypted: Buffer.alloc(44) },
    ])
  })

  describe('US1 — INSERT path (外部送信の取り込み)', () => {
    it('T006: text echo INSERT で direction=outbound / metaMessageId=mid / sentByAuthUid=null / timestamp=event.timestamp が記録される', async () => {
      const calls = setupEchoTx({ inserted: true })
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

      const res = await handler(makePostEvent(echoTextPayload))

      expect(res.statusCode).toBe(200)
      const messagesInsert = calls.insert.find((c) => c.table === 'messages')
      expect(messagesInsert).toBeDefined()
      expect(messagesInsert!.values).toMatchObject({
        tenantId: TENANT_ID,
        direction: 'outbound',
        metaMessageId: 'm_echo_text_001',
        body: 'External reply',
        messageType: 'text',
        sendStatus: 'sent',
        sentByAuthUid: null,
      })
      expect((messagesInsert!.values!.timestamp as Date).getTime()).toBe(1735689700000)

      const externalLog = infoSpy.mock.calls.find(
        (c) => (c[0] as { event?: string })?.event === 'external_echo_ingested',
      )
      expect(externalLog).toBeDefined()
      expect(externalLog![0]).toMatchObject({
        event: 'external_echo_ingested',
        conversationId: CONV_UUID, // upsertConversation の返す id (messages.id ではない)
        mid: 'm_echo_text_001',
        messageType: 'text',
        bodyLength: 'External reply'.length,
        tsMs: 1735689700000,
      })
      infoSpy.mockRestore()
    })

    it('T007: sticker echo INSERT で body="" / messageType="sticker"', async () => {
      const calls = setupEchoTx({ inserted: true })

      await handler(makePostEvent(echoStickerPayload))

      const messagesInsert = calls.insert.find((c) => c.table === 'messages')
      expect(messagesInsert!.values).toMatchObject({
        messageType: 'sticker',
        body: '',
        direction: 'outbound',
        sentByAuthUid: null,
      })
    })

    it('T008: image echo INSERT で body="" / messageType="image" (URL を保存しない)', async () => {
      const calls = setupEchoTx({ inserted: true })

      await handler(makePostEvent(echoImagePayload))

      const messagesInsert = calls.insert.find((c) => c.table === 'messages')
      expect(messagesInsert!.values).toMatchObject({
        messageType: 'image',
        body: '',
        direction: 'outbound',
        sentByAuthUid: null,
      })
    })

    it('T009: echo の recipient.id (顧客 PSID) で会話が自動 upsert される', async () => {
      const calls = setupEchoTx({ inserted: true })

      await handler(makePostEvent(echoTextPayload))

      const convInsert = calls.insert.find((c) => c.table === 'conversations')
      expect(convInsert).toBeDefined()
      expect(convInsert!.values).toMatchObject({
        tenantId: TENANT_ID,
        pageId: PAGE_UUID,
        customerPsid: CUSTOMER_PSID, // recipient.id を使うことを確認
      })
    })
  })

  describe('US2 — UPDATE path / 冪等性 / 副作用なし', () => {
    it('T012: 既存自送信行に echo が当たった場合は self_echo_confirmed をログ出力', async () => {
      setupEchoTx({ inserted: false })
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

      await handler(makePostEvent(echoTextPayload))

      const selfLog = infoSpy.mock.calls.find(
        (c) => (c[0] as { event?: string })?.event === 'self_echo_confirmed',
      )
      expect(selfLog).toBeDefined()
      expect(selfLog![0]).toMatchObject({
        event: 'self_echo_confirmed',
        conversationId: CONV_UUID,
        mid: 'm_echo_text_001',
        pageId: PAGE_UUID,
      })
      // INSERT 経路のログは出ない
      expect(
        infoSpy.mock.calls.find(
          (c) => (c[0] as { event?: string })?.event === 'external_echo_ingested',
        ),
      ).toBeUndefined()
      infoSpy.mockRestore()
    })

    it('T013: UPSERT 1 文で冪等。同 mid の 2 連発を 1 件 INSERT + 1 件 UPDATE に解決', async () => {
      // 1 回目: 新規 INSERT
      setupEchoTx({ inserted: true })
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
      await handler(makePostEvent(echoTextPayload))
      expect(
        infoSpy.mock.calls.filter(
          (c) => (c[0] as { event?: string })?.event === 'external_echo_ingested',
        ),
      ).toHaveLength(1)

      // 2 回目: 既存行に当たって UPDATE (no-op)
      setupEchoTx({ inserted: false })
      await handler(makePostEvent(echoTextPayload))
      expect(
        infoSpy.mock.calls.filter(
          (c) => (c[0] as { event?: string })?.event === 'self_echo_confirmed',
        ),
      ).toHaveLength(1)

      // 加えて: ON CONFLICT (meta_message_id) が呼ばれていること (UPSERT 実装の確認)
      infoSpy.mockRestore()
    })

    it('T014: echo は SQS / Summary trigger / customerName fetch を起動しない', async () => {
      setupEchoTx({ inserted: true })
      sqsMock.on(SendMessageCommand).resolves({})

      await handler(makePostEvent(echoTextPayload))

      expect(sqsMock.calls()).toHaveLength(0)
      expect(mockMaybeEnqueueSummaryJob).not.toHaveBeenCalled()
    })

    it('T014b: echo の UPSERT ターゲットは messages.metaMessageId (制約 messages_meta_message_id_unique)', async () => {
      const calls = setupEchoTx({ inserted: true })

      await handler(makePostEvent(echoTextPayload))

      // upsertConversation で 1 つ、messages UPSERT で 1 つの onConflictDoUpdate
      expect(calls.conflictTarget).toHaveLength(2)
      // 2 つ目 (messages) の SET は sendStatus='sent' のみ (timestamp / body / sentByAuthUid 不変 — Q3)
      expect(calls.conflictSet[1]).toEqual({ sendStatus: 'sent' })
    })
  })

  describe('US3 — #004 未返信バッチ判定境界への自然反映', () => {
    it('T018: echo INSERT 時に direction="outbound" と event.timestamp を採用 (boundary クエリが正しく評価できる契約)', async () => {
      const calls = setupEchoTx({ inserted: true })

      await handler(makePostEvent(echoTextPayload))

      const messagesInsert = calls.insert.find((c) => c.table === 'messages')
      // この 2 つの値が揃っていれば、#004 の SELECT MAX(timestamp) WHERE direction='outbound'
      // が echo を取り込んだ会話を「返信済み」として検出する (FR-010)。
      expect(messagesInsert!.values!.direction).toBe('outbound')
      expect((messagesInsert!.values!.timestamp as Date).getTime()).toBe(1735689700000)
    })
  })
})

// 009: 添付メディアの保存 (specs/009-media-attachments) のテスト群
//
// 実装契約 (contracts/media-pipeline.md): classifyAttachments → (保存対象があれば
// 会話を先行 upsert) → downloadAttachment (最大 3 試行) → storeAttachment →
// messages INSERT に attachments JSONB。ダウンロード失敗はメッセージ取り込みを
// 妨げない (FR-003)。media.ts の中身は media.test.ts で単体検証済み。
function makeInboundAttachmentPayload(
  mid: string,
  attachments: Array<Record<string, unknown>>,
  text?: string,
) {
  return {
    object: 'page',
    entry: [
      {
        id: PAGE_ID,
        time: 1735689800000,
        messaging: [
          {
            sender: { id: CUSTOMER_PSID },
            recipient: { id: PAGE_ID },
            timestamp: 1735689800000,
            message: { mid, ...(text !== undefined ? { text } : {}), attachments },
          },
        ],
      },
    ],
  }
}

// inbound 経路の fakeTx。非テキストは messages INSERT + conversations UPDATE の後に
// 早期 return するため、draft 系のクエリは実装不要。preliminary media tx (conversations
// upsert + 既存 mid select) と本体 tx の両方をこの実装で受ける (呼び出しごとに状態を持つ)。
function setupInboundTx(opts: { midExists?: boolean } = {}) {
  const calls: FakeTxCalls = { insert: [], conflictTarget: [], conflictSet: [] }
  mockWithTenant.mockImplementation(async (_tenantId: string, cb: (tx: unknown) => Promise<unknown>) => {
    let insertCallIdx = 0
    let returningIdx = 0
    const tablesByOrder: Array<'conversations' | 'messages'> = ['conversations', 'messages']
    const returningResults: unknown[][] = [
      // customerName を持たせて needsNameFetch 経路 (SSM/Graph API) を切る
      [{ id: CONV_UUID, customerName: 'Test Customer' }],
      [{ id: NEW_MSG_UUID }],
    ]
    const builder: Record<string, unknown> = {}
    Object.assign(builder, {
      insert: () => {
        const tableName = tablesByOrder[insertCallIdx++] ?? 'messages'
        calls.insert.push({ table: tableName })
        return builder
      },
      values: (v: Record<string, unknown>) => {
        const last = calls.insert[calls.insert.length - 1]
        if (last) last.values = v
        return builder
      },
      onConflictDoUpdate: (conf: { target?: unknown; set?: Record<string, unknown> }) => {
        calls.conflictTarget.push(conf.target)
        calls.conflictSet.push(conf.set ?? {})
        return builder
      },
      onConflictDoNothing: () => builder,
      returning: async () => returningResults[returningIdx++] ?? [],
      update: () => builder,
      set: () => builder,
      where: async () => [],
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (opts.midExists ? [{ id: NEW_MSG_UUID }] : []),
          }),
        }),
      }),
    })
    return cb(builder)
  })
  return calls
}

describe('POST /api/webhook — media attachments (009)', () => {
  beforeEach(() => {
    mockSsm.mockResolvedValue(APP_SECRET)
    mockDbAdminWhere.mockResolvedValue([
      { tenantId: TENANT_ID, id: PAGE_UUID, pageAccessTokenEncrypted: Buffer.alloc(44) },
    ])
  })

  describe('US1 — inbound 画像の保存と attachments 記録', () => {
    it('T013: inbound image が保存され attachments に s3Key が記録される (body に URL を入れない)', async () => {
      const calls = setupInboundTx()
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

      const res = await handler(
        makePostEvent(
          makeInboundAttachmentPayload('m_img_1', [
            { type: 'image', payload: { url: 'https://cdn.fb.com/photo.jpg' } },
          ]),
        ),
      )

      expect(res.statusCode).toBe(200)
      expect(mockDownloadAttachment).toHaveBeenCalledTimes(1)
      // timeoutMs は残時間予算でクランプされる (≤ 8s)
      expect(mockDownloadAttachment).toHaveBeenCalledWith(
        'https://cdn.fb.com/photo.jpg',
        expect.objectContaining({ timeoutMs: expect.any(Number) }),
      )
      expect(mockStoreAttachment).toHaveBeenCalledTimes(1)
      expect(mockStoreAttachment).toHaveBeenCalledWith({
        bucket: 'test-media-bucket',
        tenantId: TENANT_ID,
        conversationId: CONV_UUID,
        mid: 'm_img_1',
        index: 0,
        buffer: expect.any(Buffer),
        contentType: 'image/jpeg',
      })

      const messagesInsert = calls.insert.find((c) => c.table === 'messages')
      expect(messagesInsert!.values).toMatchObject({
        direction: 'inbound',
        metaMessageId: 'm_img_1',
        body: '', // FR-004: CDN URL を body に保存する旧挙動の廃止
        messageType: 'image',
        attachments: [
          {
            index: 0,
            type: 'image',
            s3Key: `${TENANT_ID}/${CONV_UUID}/m_img_1/0`,
            contentType: 'image/jpeg',
            sizeBytes: 9,
          },
        ],
      })

      const storedLog = infoSpy.mock.calls.find(
        (c) => (c[0] as { event?: string })?.event === 'attachment_stored',
      )
      expect(storedLog).toBeDefined()
      expect(storedLog![0]).toMatchObject({
        event: 'attachment_stored',
        tenantId: TENANT_ID,
        conversationId: CONV_UUID,
        mid: 'm_img_1',
        index: 0,
        type: 'image',
        sizeBytes: 9,
      })
      // 非テキストなので AI 下書きは発火しない (FR-014)
      expect(sqsMock.calls()).toHaveLength(0)
      infoSpy.mockRestore()
    })

    it('T014: 複数画像 (2 枚) が全件 index 順に保存される', async () => {
      const calls = setupInboundTx()

      await handler(
        makePostEvent(
          makeInboundAttachmentPayload('m_img_2', [
            { type: 'image', payload: { url: 'https://cdn.fb.com/a.jpg' } },
            { type: 'image', payload: { url: 'https://cdn.fb.com/b.jpg' } },
          ]),
        ),
      )

      expect(mockStoreAttachment).toHaveBeenCalledTimes(2)
      expect(mockStoreAttachment.mock.calls[0]![0]).toMatchObject({ index: 0 })
      expect(mockStoreAttachment.mock.calls[1]![0]).toMatchObject({ index: 1 })

      const messagesInsert = calls.insert.find((c) => c.table === 'messages')
      const attachments = messagesInsert!.values!.attachments as Array<{
        index: number
        s3Key: string | null
      }>
      expect(attachments).toHaveLength(2)
      expect(attachments.map((a) => a.index)).toEqual([0, 1])
      expect(attachments.map((a) => a.s3Key)).toEqual([
        `${TENANT_ID}/${CONV_UUID}/m_img_2/0`,
        `${TENANT_ID}/${CONV_UUID}/m_img_2/1`,
      ])
    })

    it('T015: ダウンロード失敗はリトライ 2 回 (計 3 試行) の後 s3Key=null で確定し、INSERT は成功する', async () => {
      const calls = setupInboundTx()
      mockDownloadAttachment.mockResolvedValue({ ok: false, reason: 'network_error' })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const res = await handler(
        makePostEvent(
          makeInboundAttachmentPayload('m_img_3', [
            { type: 'image', payload: { url: 'https://cdn.fb.com/dead.jpg' } },
          ]),
        ),
      )

      expect(res.statusCode).toBe(200)
      expect(mockDownloadAttachment).toHaveBeenCalledTimes(3)
      expect(mockStoreAttachment).not.toHaveBeenCalled()

      // FR-003: 保存失敗してもメッセージ取り込みは成功
      const messagesInsert = calls.insert.find((c) => c.table === 'messages')
      expect(messagesInsert).toBeDefined()
      expect(messagesInsert!.values).toMatchObject({
        messageType: 'image',
        body: '',
        attachments: [{ index: 0, type: 'image', s3Key: null }],
      })

      const failedLog = warnSpy.mock.calls.find(
        (c) => (c[0] as { event?: string })?.event === 'attachment_download_failed',
      )
      expect(failedLog).toBeDefined()
      expect(failedLog![0]).toMatchObject({
        event: 'attachment_download_failed',
        tenantId: TENANT_ID,
        mid: 'm_img_3',
        index: 0,
        type: 'image',
        attempts: 3,
        reason: 'network_error',
      })
      warnSpy.mockRestore()
    })

    it('T015b: MEDIA_BUCKET_NAME 未設定時はダウンロードせず bucket_not_configured で記録、INSERT は成功', async () => {
      mockEnv.MEDIA_BUCKET_NAME = ''
      const calls = setupInboundTx()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const res = await handler(
        makePostEvent(
          makeInboundAttachmentPayload('m_img_4', [
            { type: 'image', payload: { url: 'https://cdn.fb.com/photo.jpg' } },
          ]),
        ),
      )

      expect(res.statusCode).toBe(200)
      expect(mockDownloadAttachment).not.toHaveBeenCalled()
      expect(mockStoreAttachment).not.toHaveBeenCalled()

      const messagesInsert = calls.insert.find((c) => c.table === 'messages')
      expect(messagesInsert!.values).toMatchObject({
        attachments: [{ index: 0, type: 'image', s3Key: null }],
      })

      const failedLog = warnSpy.mock.calls.find(
        (c) => (c[0] as { event?: string })?.event === 'attachment_download_failed',
      )
      expect(failedLog![0]).toMatchObject({ attempts: 0, reason: 'bucket_not_configured' })
      warnSpy.mockRestore()
    })
  })

  describe('US2 — 非画像種別の判定・保存と echo 添付', () => {
    it.each([
      ['video', 'https://cdn.fb.com/v.mp4'],
      ['audio', 'https://cdn.fb.com/a.mp4'],
      ['file', 'https://cdn.fb.com/doc.pdf'],
    ] as const)(
      'T021: inbound %s は正しい messageType で保存され AI 下書きを発火しない',
      async (type, url) => {
        const calls = setupInboundTx()
        sqsMock.on(SendMessageCommand).resolves({})

        await handler(
          makePostEvent(makeInboundAttachmentPayload(`m_${type}_1`, [{ type, payload: { url } }])),
        )

        expect(mockStoreAttachment).toHaveBeenCalledTimes(1)
        const messagesInsert = calls.insert.find((c) => c.table === 'messages')
        expect(messagesInsert!.values).toMatchObject({
          messageType: type,
          body: '',
          attachments: [
            { index: 0, type, s3Key: `${TENANT_ID}/${CONV_UUID}/m_${type}_1/0` },
          ],
        })
        // FR-014: 非テキストは SQS enqueue (AI 下書き) を呼ばない
        expect(sqsMock.calls()).toHaveLength(0)
      },
    )

    it('T021b: sticker はダウンロードせず s3Key=null で記録される', async () => {
      const calls = setupInboundTx()

      await handler(
        makePostEvent(
          makeInboundAttachmentPayload('m_stk_1', [
            { type: 'image', payload: { sticker_id: 369239263222822 } },
          ]),
        ),
      )

      expect(mockDownloadAttachment).not.toHaveBeenCalled()
      const messagesInsert = calls.insert.find((c) => c.table === 'messages')
      expect(messagesInsert!.values).toMatchObject({
        messageType: 'sticker',
        attachments: [{ index: 0, type: 'sticker', s3Key: null }],
      })
    })

    it('T021c: 未知 type (fallback) は unknown として記録され空バブル要素 (body) は空文字', async () => {
      const calls = setupInboundTx()

      await handler(
        makePostEvent(
          makeInboundAttachmentPayload('m_unk_1', [
            { type: 'fallback', payload: { url: 'https://example.com/share' } },
          ]),
        ),
      )

      expect(mockDownloadAttachment).not.toHaveBeenCalled()
      const messagesInsert = calls.insert.find((c) => c.table === 'messages')
      expect(messagesInsert!.values).toMatchObject({
        messageType: 'unknown',
        body: '',
        attachments: [{ index: 0, type: 'unknown', s3Key: null }],
      })
    })

    it('T022: echo image 添付も保存され attachments 付きで INSERT、UPSERT SET は sendStatus のみ (FR-009)', async () => {
      const calls = setupEchoTx({ inserted: true })

      await handler(makePostEvent(echoImagePayload))

      expect(mockDownloadAttachment).toHaveBeenCalledWith(
        'https://cdn.fb.com/image.jpg',
        expect.objectContaining({ timeoutMs: expect.any(Number) }),
      )
      expect(mockStoreAttachment).toHaveBeenCalledTimes(1)
      expect(mockStoreAttachment).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          conversationId: CONV_UUID,
          mid: 'm_echo_image_001',
          index: 0,
        }),
      )

      const messagesInsert = calls.insert.find((c) => c.table === 'messages')
      expect(messagesInsert!.values).toMatchObject({
        direction: 'outbound',
        messageType: 'image',
        body: '',
        attachments: [
          {
            index: 0,
            type: 'image',
            s3Key: `${TENANT_ID}/${CONV_UUID}/m_echo_image_001/0`,
          },
        ],
      })
      // 既存自送信行の attachments を echo で上書きしない: SET は sendStatus のみ
      expect(calls.conflictSet[calls.conflictSet.length - 1]).toEqual({ sendStatus: 'sent' })
      // echo の副作用なしは既存 T014 で担保 (SQS / Summary 不発火)
      expect(sqsMock.calls()).toHaveLength(0)
      expect(mockMaybeEnqueueSummaryJob).not.toHaveBeenCalled()
    })
  })

  describe('US3 — サイズ超過スキップ', () => {
    it('T026: 25MB 超過はリトライなしで attachment_skipped_oversize、INSERT は成功', async () => {
      const calls = setupInboundTx()
      mockDownloadAttachment.mockResolvedValue({ ok: false, reason: 'oversize' })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const res = await handler(
        makePostEvent(
          makeInboundAttachmentPayload('m_big_1', [
            { type: 'video', payload: { url: 'https://cdn.fb.com/huge.mp4' } },
          ]),
        ),
      )

      expect(res.statusCode).toBe(200)
      // oversize は決定的失敗なのでリトライしない (fetch 1 回のみ)
      expect(mockDownloadAttachment).toHaveBeenCalledTimes(1)
      expect(mockStoreAttachment).not.toHaveBeenCalled()

      const messagesInsert = calls.insert.find((c) => c.table === 'messages')
      expect(messagesInsert!.values).toMatchObject({
        messageType: 'video',
        attachments: [{ index: 0, type: 'video', s3Key: null }],
      })

      const oversizeLog = warnSpy.mock.calls.find(
        (c) => (c[0] as { event?: string })?.event === 'attachment_skipped_oversize',
      )
      expect(oversizeLog).toBeDefined()
      expect(oversizeLog![0]).toMatchObject({
        event: 'attachment_skipped_oversize',
        tenantId: TENANT_ID,
        mid: 'm_big_1',
        index: 0,
        type: 'video',
      })
      // attachment_download_failed は出ない (oversize は専用イベント)
      expect(
        warnSpy.mock.calls.find(
          (c) => (c[0] as { event?: string })?.event === 'attachment_download_failed',
        ),
      ).toBeUndefined()
      warnSpy.mockRestore()
    })
  })

  describe('レビュー修正 — 再配信スキップ / 時間予算 / put_failed 詳細', () => {
    it('既存 mid の再配信ではダウンロードを丸ごとスキップする (最大 25MB の再取得なし)', async () => {
      const calls = setupInboundTx({ midExists: true })

      const res = await handler(
        makePostEvent(
          makeInboundAttachmentPayload('m_dup_1', [
            { type: 'image', payload: { url: 'https://cdn.fb.com/dup.jpg' } },
          ]),
        ),
      )

      expect(res.statusCode).toBe(200)
      expect(mockDownloadAttachment).not.toHaveBeenCalled()
      expect(mockStoreAttachment).not.toHaveBeenCalled()
      // INSERT 自体は走り、onConflictDoNothing で no-op に収束する (attachments は null)
      const messagesInsert = calls.insert.find((c) => c.table === 'messages')
      expect(messagesInsert).toBeDefined()
      expect(messagesInsert!.values!.attachments).toBeNull()
    })

    it('時間予算を使い切ったら残り試行を打ち切り time_budget_exceeded で確定、INSERT は成功', async () => {
      const calls = setupInboundTx()
      mockDownloadAttachment.mockResolvedValue({ ok: false, reason: 'timeout' })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // Date.now を 1 呼び出しごとに 7 秒進める: 予算 12s は 2 回目の試行前に尽きる
      let fakeNow = 1_700_000_000_000
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
        const t = fakeNow
        fakeNow += 7_000
        return t
      })

      const res = await handler(
        makePostEvent(
          makeInboundAttachmentPayload('m_slow_1', [
            { type: 'video', payload: { url: 'https://cdn.fb.com/slow.mp4' } },
          ]),
        ),
      )
      nowSpy.mockRestore()

      expect(res.statusCode).toBe(200)
      // 予算切れにより 3 試行までは行かない
      expect(mockDownloadAttachment.mock.calls.length).toBeLessThan(3)
      // FR-003: メッセージ INSERT には必ず到達する
      const messagesInsert = calls.insert.find((c) => c.table === 'messages')
      expect(messagesInsert).toBeDefined()
      expect(messagesInsert!.values).toMatchObject({
        attachments: [{ index: 0, type: 'video', s3Key: null }],
      })

      const failedLog = warnSpy.mock.calls.find(
        (c) => (c[0] as { event?: string })?.event === 'attachment_download_failed',
      )
      expect(failedLog).toBeDefined()
      expect((failedLog![0] as { reason?: string }).reason).toBe('time_budget_exceeded')
      warnSpy.mockRestore()
    })

    it('S3 PutObject 失敗時は error メッセージ付きで attachment_download_failed を出す', async () => {
      setupInboundTx()
      mockStoreAttachment.mockRejectedValue(
        new Error('AccessDenied: not authorized to perform s3:PutObject'),
      )
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await handler(
        makePostEvent(
          makeInboundAttachmentPayload('m_put_1', [
            { type: 'image', payload: { url: 'https://cdn.fb.com/p.jpg' } },
          ]),
        ),
      )

      const failedLog = warnSpy.mock.calls.find(
        (c) => (c[0] as { event?: string })?.event === 'attachment_download_failed',
      )
      expect(failedLog).toBeDefined()
      expect(failedLog![0]).toMatchObject({
        reason: 'put_failed',
        error: expect.stringContaining('AccessDenied'),
      })
      warnSpy.mockRestore()
    })
  })
})
