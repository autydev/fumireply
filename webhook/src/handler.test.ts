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

// hoisted mocks
const { mockSsm, mockWithTenant, mockDbAdminWhere } = vi.hoisted(() => ({
  mockSsm: vi.fn(),
  mockWithTenant: vi.fn(),
  mockDbAdminWhere: vi.fn(),
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
})

afterEach(() => {
  sqsMock.reset()
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
    mockDbAdminWhere.mockResolvedValue([{ tenantId: TENANT_ID, id: PAGE_UUID }])
    mockWithTenant.mockResolvedValue(NEW_MSG_UUID)
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'sqs-msg-id' })

    const res = await handler(makePostEvent(textPayload))

    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('EVENT_RECEIVED')
    expect(mockWithTenant).toHaveBeenCalledWith(TENANT_ID, expect.any(Function))
    expect(sqsMock.calls()).toHaveLength(1)
    const sqsInput = sqsMock.calls()[0].args[0].input as { MessageBody: string }
    expect(JSON.parse(sqsInput.MessageBody)).toEqual({ messageId: NEW_MSG_UUID })
  })

  it('does not enqueue SQS for duplicate mid (withTenant returns null)', async () => {
    mockSsm.mockResolvedValue(APP_SECRET)
    mockDbAdminWhere.mockResolvedValue([{ tenantId: TENANT_ID, id: PAGE_UUID }])
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
    mockDbAdminWhere.mockResolvedValue([{ tenantId: TENANT_ID, id: PAGE_UUID }])
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
    mockDbAdminWhere.mockResolvedValue([{ tenantId: TENANT_ID, id: PAGE_UUID }])
    mockWithTenant.mockResolvedValue(NEW_MSG_UUID)
    sqsMock.on(SendMessageCommand).rejects(new Error('SQS unavailable'))

    const res = await handler(makePostEvent(textPayload))

    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('EVENT_RECEIVED')
  })
})
