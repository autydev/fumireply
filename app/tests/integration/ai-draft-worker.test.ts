// @vitest-environment node
// Integration: AI Worker Lambda handler — SQS event → Anthropic (mocked) → ai_drafts UPDATE to 'ready'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SQSEvent } from 'aws-lambda'

const MESSAGE_ID      = '11111111-1111-4111-9111-111111111111'
const TENANT_ID       = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa'
const CONVERSATION_ID = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb'

// hoisted mocks
const { mockSsm, mockDbAdminWhere, mockWithTenant, mockAnthropicCreate } = vi.hoisted(() => ({
  mockSsm: vi.fn<() => Promise<string>>(),
  mockDbAdminWhere: vi.fn(),
  mockWithTenant: vi.fn(),
  mockAnthropicCreate: vi.fn(),
}))

vi.mock('../../../ai-worker/src/services/ssm', () => ({
  getSsmParameter: mockSsm,
  clearSsmCache: vi.fn(),
}))

vi.mock('../../../ai-worker/src/db/client', () => ({
  db: {},
  dbAdmin: {
    select: () => ({ from: () => ({ where: mockDbAdminWhere }) }),
  },
}))

vi.mock('../../../ai-worker/src/db/with-tenant', () => ({
  withTenant: mockWithTenant,
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockAnthropicCreate }
  },
}))

const { handler } = await import('../../../ai-worker/src/handler')

// --- helpers ---
function makeSqsEvent(body: unknown): SQSEvent {
  return {
    Records: [
      {
        messageId: 'sqs-1',
        receiptHandle: 'handle-1',
        body: JSON.stringify(body),
        attributes: {
          ApproximateReceiveCount: '1',
          SentTimestamp: '1735689600000',
          SenderId: 'sender',
          ApproximateFirstReceiveTimestamp: '1735689600000',
        },
        messageAttributes: {},
        md5OfBody: 'md5',
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:ap-northeast-1:123:queue',
        awsRegion: 'ap-northeast-1',
      },
    ],
  }
}

function makeAnthropicResponse(text = 'Draft reply from AI.') {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: 'claude-haiku-4-5-20251001',
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 80,
      output_tokens: 15,
      cache_creation_input_tokens: 60,
      cache_read_input_tokens: 0,
    },
  }
}

// Captured UPDATE arguments for assertions
type DraftUpdate = { status: string; body?: string; error?: string }
let capturedUpdate: DraftUpdate | null = null

// Conversation-scoped draft job (coalesce: trigger === latest inbound)
function draftJob(overrides: Record<string, unknown> = {}) {
  return {
    jobType: 'draft',
    conversationId: CONVERSATION_ID,
    triggerMessageId: MESSAGE_ID,
    ...overrides,
  }
}

// Read tx mock for the conversation-scoped flow. Query order:
//   1. latest inbound text (coalesce)  — from().where().orderBy().limit()
//   2. settings (leftJoin)             — from().leftJoin().where()
//   3. last outbound ts (008)          — from().where().orderBy().limit()
//   4. unanswered batch                — from().where().orderBy().limit()
//   5. context history                 — from().where().orderBy().limit()
function buildReadTx({
  latestInboundId = MESSAGE_ID,
  unansweredRows = [{ body: 'Customer question here.' }],
  historyRows = [{ direction: 'inbound', body: 'Customer question here.', messageType: 'text' }],
}: {
  latestInboundId?: string | null
  unansweredRows?: Array<{ body: string }>
  historyRows?: Array<{ direction: string; body: string; messageType: string }>
} = {}) {
  let n = 0
  const limitChain = (rows: unknown) => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ orderBy: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(rows)) })) })),
    })),
  })
  return {
    select: vi.fn(() => {
      n++
      if (n === 1) return limitChain(latestInboundId ? [{ id: latestInboundId }] : [])
      if (n === 2)
        return {
          from: vi.fn(() => ({
            leftJoin: vi.fn(() => ({
              where: vi.fn(() =>
                Promise.resolve([
                  {
                    summary: null,
                    lastSummarizedAt: null,
                    tonePreset: null,
                    customPrompt: null,
                    pageCustomPrompt: null,
                  },
                ]),
              ),
            })),
          })),
        }
      if (n === 3) return limitChain([{ ts: null }])
      if (n === 4) return limitChain(unansweredRows)
      return limitChain(historyRows)
    }),
  }
}

function buildWriteTx(onUpdate: (v: DraftUpdate) => void) {
  return {
    update: vi.fn(() => ({
      set: vi.fn((values: DraftUpdate) => {
        onUpdate(values)
        return { where: vi.fn().mockResolvedValue(undefined) }
      }),
    })),
  }
}

beforeEach(() => {
  capturedUpdate = null
  mockSsm.mockResolvedValue('test-anthropic-api-key')
  mockDbAdminWhere.mockResolvedValue([{ tenantId: TENANT_ID }])

  let withTenantCallCount = 0
  mockWithTenant.mockImplementation(
    async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
      withTenantCallCount++
      if (withTenantCallCount === 1) return fn(buildReadTx())
      return fn(buildWriteTx((v) => (capturedUpdate = v)))
    },
  )
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('AI Worker handler — integration', () => {
  it('success: SQS event → Anthropic called → ai_drafts updated to ready', async () => {
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse('Here is a suggested reply.'))

    await handler(makeSqsEvent(draftJob()), {} as never, vi.fn())

    expect(mockAnthropicCreate).toHaveBeenCalledOnce()
    expect(capturedUpdate).not.toBeNull()
    expect(capturedUpdate?.status).toBe('ready')
    expect(capturedUpdate?.body).toBe('Here is a suggested reply.')
  })

  it('conversation not found in DB: handler skips without error (ACK to SQS)', async () => {
    mockDbAdminWhere.mockResolvedValue([]) // tenant resolution returns empty

    await expect(handler(makeSqsEvent(draftJob()), {} as never, vi.fn())).resolves.not.toThrow()

    expect(mockAnthropicCreate).not.toHaveBeenCalled()
  })

  it('invalid UUID in SQS body: handler skips without error', async () => {
    await expect(
      handler(makeSqsEvent(draftJob({ conversationId: 'not-a-uuid' })), {} as never, vi.fn()),
    ).resolves.not.toThrow()

    expect(mockAnthropicCreate).not.toHaveBeenCalled()
  })

  it('Anthropic 401: updates ai_drafts to failed with auth_failed error', async () => {
    const authError = Object.assign(new Error('Authentication failure'), { status: 401 })
    mockAnthropicCreate.mockRejectedValue(authError)

    await handler(makeSqsEvent(draftJob()), {} as never, vi.fn())

    expect(capturedUpdate?.status).toBe('failed')
    expect(capturedUpdate?.error).toBe('auth_failed')
  })

  it('Anthropic 500 ×3: exhausts retries → updates to failed with server_error', async () => {
    vi.useFakeTimers()
    try {
      const serverError = Object.assign(new Error('Internal server error'), { status: 500 })
      mockAnthropicCreate.mockRejectedValue(serverError)

      const handlerPromise = handler(makeSqsEvent(draftJob()), {} as never, vi.fn())
      // Advance all retry delays (1s + 3s + 9s) without waiting real time
      await vi.runAllTimersAsync()
      await handlerPromise

      expect(capturedUpdate?.status).toBe('failed')
      expect(capturedUpdate?.error).toBe('server_error')
    } finally {
      vi.useRealTimers()
    }
  })
})
