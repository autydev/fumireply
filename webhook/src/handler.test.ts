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
const { mockSsm, mockWithTenant, mockDbAdminWhere, mockMaybeEnqueueSummaryJob } = vi.hoisted(() => ({
  mockSsm: vi.fn(),
  mockWithTenant: vi.fn(),
  mockDbAdminWhere: vi.fn(),
  mockMaybeEnqueueSummaryJob: vi.fn(),
}))

vi.mock('./env', () => ({
  env: {
    SSM_PATH_PREFIX: '/fumireply/test',
    SQS_QUEUE_URL: 'https://sqs.ap-northeast-1.amazonaws.com/123/test-queue',
    AWS_REGION: 'ap-northeast-1',
  },
}))

vi.mock('./services/ssm', () => ({
  getSsmParameter: mockSsm,
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

function setupEchoTx(opts: { inserted: boolean; convId?: string; msgId?: string }) {
  const calls: FakeTxCalls = { insert: [], conflictTarget: [], conflictSet: [] }
  mockWithTenant.mockImplementation(async (_tenantId: string, cb: (tx: unknown) => Promise<unknown>) => {
    // テーブル識別は呼び出し順で行う: echo 経路では必ず 1) conversations upsert, 2) messages
    // upsert の順で .insert() が呼ばれる。drizzle のテーブルオブジェクトをリフレクションで判別
    // するより、契約上の呼び出し順を assume するほうが堅牢。
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

      const externalLog = infoSpy.mock.calls.find((c) => c[0] === 'external_echo_ingested')
      expect(externalLog).toBeDefined()
      expect(externalLog![1]).toMatchObject({
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

      const selfLog = infoSpy.mock.calls.find((c) => c[0] === 'self_echo_confirmed')
      expect(selfLog).toBeDefined()
      expect(selfLog![1]).toMatchObject({
        mid: 'm_echo_text_001',
        pageId: PAGE_UUID,
      })
      // INSERT 経路のログは出ない
      expect(infoSpy.mock.calls.find((c) => c[0] === 'external_echo_ingested')).toBeUndefined()
      infoSpy.mockRestore()
    })

    it('T013: UPSERT 1 文で冪等。同 mid の 2 連発を 1 件 INSERT + 1 件 UPDATE に解決', async () => {
      // 1 回目: 新規 INSERT
      setupEchoTx({ inserted: true })
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
      await handler(makePostEvent(echoTextPayload))
      expect(infoSpy.mock.calls.filter((c) => c[0] === 'external_echo_ingested')).toHaveLength(1)

      // 2 回目: 既存行に当たって UPDATE (no-op)
      setupEchoTx({ inserted: false })
      await handler(makePostEvent(echoTextPayload))
      expect(infoSpy.mock.calls.filter((c) => c[0] === 'self_echo_confirmed')).toHaveLength(1)

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
