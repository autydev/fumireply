// @vitest-environment node
// Integration: webhook Lambda handler — Meta payload → signature verify → DB INSERT + SQS enqueue

import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockClient } from 'aws-sdk-client-mock'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import type { APIGatewayProxyEventV2 } from 'aws-lambda'

const APP_SECRET = 'test-app-secret-integration'
const TENANT_ID    = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa'
const PAGE_UUID    = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb'
const PAGE_FB_ID   = '111222333'
const PSID         = '999888777'
const MESSAGE_MID  = 'm_webhook_integration_001'
const NEW_MSG_UUID = 'cccccccc-cccc-4ccc-9ccc-cccccccccccc'

// hoisted mocks
const { mockSsm, mockWithTenant, mockDbAdminWhere } = vi.hoisted(() => ({
  mockSsm: vi.fn<() => Promise<string>>(),
  mockWithTenant: vi.fn(),
  mockDbAdminWhere: vi.fn(),
}))

vi.mock('../../../webhook/src/env', () => ({
  env: {
    SSM_PATH_PREFIX: '/fumireply/test',
    SQS_QUEUE_URL: 'https://sqs.ap-northeast-1.amazonaws.com/123/test-queue',
    AWS_REGION: 'ap-northeast-1',
    DATABASE_URL: 'postgres://test',
    DATABASE_URL_SERVICE_ROLE: 'postgres://test-admin',
  },
}))

vi.mock('../../../webhook/src/services/ssm', () => ({
  getSsmParameter: mockSsm,
}))

vi.mock('../../../webhook/src/db/client', () => ({
  db: {},
  dbAdmin: {
    select: () => ({ from: () => ({ where: mockDbAdminWhere }) }),
  },
}))

vi.mock('../../../webhook/src/db/with-tenant', () => ({
  withTenant: mockWithTenant,
}))

const sqsMock = mockClient(SQSClient)

const { handler } = await import('../../../webhook/src/handler')

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
      requestId: 'req-int-1',
      routeKey: 'POST /api/webhook',
      stage: '$default',
      time: '01/Jan/2025:00:00:00 +0000',
      timeEpoch: 1735689600000,
    },
  }
}

function makeTextPayload() {
  return {
    object: 'page',
    entry: [
      {
        id: PAGE_FB_ID,
        time: 1735689600000,
        messaging: [
          {
            sender: { id: PSID },
            recipient: { id: PAGE_FB_ID },
            timestamp: 1735689600000,
            message: { mid: MESSAGE_MID, text: 'Hello from integration test' },
          },
        ],
      },
    ],
  }
}

beforeEach(() => {
  sqsMock.reset()
  sqsMock.on(SendMessageCommand).resolves({ MessageId: 'sqs-message-id' })

  mockSsm.mockResolvedValue(APP_SECRET)
  mockDbAdminWhere.mockResolvedValue([{ tenantId: TENANT_ID, id: PAGE_UUID }])

  mockWithTenant.mockImplementation(
    async (_tenantId: string, fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
      const mockTx = {
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockReturnThis(),
        onConflictDoUpdate: vi.fn().mockReturnThis(),
        onConflictDoNothing: vi.fn().mockReturnThis(),
        returning: vi.fn()
          .mockResolvedValueOnce([{ id: NEW_MSG_UUID }]) // conversations upsert
          .mockResolvedValueOnce([{ id: NEW_MSG_UUID }]) // messages INSERT
          .mockResolvedValueOnce([{ id: 'draft-id' }]), // ai_drafts INSERT
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(undefined),
        execute: vi.fn().mockResolvedValue(undefined),
      }
      return fn(mockTx as unknown as Parameters<typeof fn>[0])
    },
  )
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('webhook handler — integration', () => {
  it('POST text message: DB INSERT + SQS enqueue', async () => {
    const result = await handler(makePostEvent(makeTextPayload()))

    expect(result.statusCode).toBe(200)
    expect(result.body).toBe('EVENT_RECEIVED')
    expect(mockWithTenant).toHaveBeenCalled()

    const sqsCalls = sqsMock.commandCalls(SendMessageCommand)
    expect(sqsCalls).toHaveLength(1)
    const sqsBody = JSON.parse(sqsCalls[0].args[0].input.MessageBody ?? '{}') as { messageId: string }
    expect(sqsBody.messageId).toBe(NEW_MSG_UUID)
  })

  it('POST with invalid signature: returns 401, no DB call', async () => {
    const result = await handler(makePostEvent(makeTextPayload(), { badSig: true }))

    expect(result.statusCode).toBe(401)
    expect(mockWithTenant).not.toHaveBeenCalled()
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0)
  })

  it('POST sticker message: DB INSERT but no SQS enqueue (non-text)', async () => {
    const stickerPayload = {
      object: 'page',
      entry: [
        {
          id: PAGE_FB_ID,
          time: 1735689600000,
          messaging: [
            {
              sender: { id: PSID },
              recipient: { id: PAGE_FB_ID },
              timestamp: 1735689600000,
              message: {
                mid: 'm_sticker_001',
                attachments: [{ type: 'image', payload: { sticker_id: 369239263222822 } }],
              },
            },
          ],
        },
      ],
    }

    // Sticker: conversations INSERT but messages INSERT returns empty (ON CONFLICT DO NOTHING)
    mockWithTenant.mockImplementationOnce(
      async (_: string, fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const mockTx = {
          insert: vi.fn().mockReturnThis(),
          values: vi.fn().mockReturnThis(),
          onConflictDoUpdate: vi.fn().mockReturnThis(),
          onConflictDoNothing: vi.fn().mockReturnThis(),
          returning: vi.fn()
            .mockResolvedValueOnce([{ id: NEW_MSG_UUID }]) // conversations
            .mockResolvedValueOnce([{ id: NEW_MSG_UUID }]) // messages
            .mockResolvedValueOnce([]),                    // ai_drafts — empty (sticker → no draft)
          update: vi.fn().mockReturnThis(),
          set: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValue(undefined),
        }
        return fn(mockTx as unknown as Parameters<typeof fn>[0])
      },
    )

    const result = await handler(makePostEvent(stickerPayload))

    expect(result.statusCode).toBe(200)
    // Sticker does not enqueue to SQS (messageType !== 'text')
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0)
  })

  it('POST unknown page: skips processing, returns 200', async () => {
    mockDbAdminWhere.mockResolvedValue([]) // page not found

    const result = await handler(makePostEvent(makeTextPayload()))

    expect(result.statusCode).toBe(200)
    expect(mockWithTenant).not.toHaveBeenCalled()
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0)
  })

  it('SQS enqueue fails: still returns 200 (best-effort)', async () => {
    sqsMock.on(SendMessageCommand).rejects(new Error('SQS timeout'))

    const result = await handler(makePostEvent(makeTextPayload()))

    expect(result.statusCode).toBe(200)
    expect(result.body).toBe('EVENT_RECEIVED')
  })
})
