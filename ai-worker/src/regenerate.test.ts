import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SQSEvent } from 'aws-lambda'

// 005: tests for the regenerate-aware branches added to processDraftJob.
// Uses the same mocking pattern as handler.test.ts.

const MESSAGE_ID = '11111111-1111-4111-9111-111111111111'
const NEWER_INBOUND_ID = '33333333-3333-4333-9333-333333333333'
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa'
const CONVERSATION_ID = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb'
const API_KEY = 'test-anthropic-api-key'

const { mockSsm, mockDbAdminWhere, mockWithTenant, mockAnthropicCreate, mockSqsSend } = vi.hoisted(
  () => ({
    mockSsm: vi.fn<() => Promise<string>>(),
    mockDbAdminWhere: vi.fn(),
    mockWithTenant: vi.fn(),
    mockAnthropicCreate: vi.fn(),
    mockSqsSend: vi.fn<(input: unknown) => Promise<void>>(),
  }),
)

vi.mock('./services/ssm', () => ({
  getSsmParameter: mockSsm,
  clearSsmCache: vi.fn(),
}))

// dbAdmin is used in two shapes in handler.ts:
//   1. tenant resolve: .select().from().where(...) → resolves
//   2. follow-up latest inbound (005): .select().from().where(...).orderBy(...).limit(1) → resolves
// We wire `where` to return both an awaitable thenable AND a chain extension so
// either shape works against the same mock queue.
function makeChain(promise: Promise<unknown>) {
  return {
    then: (...args: Parameters<Promise<unknown>['then']>) => promise.then(...args),
    catch: (...args: Parameters<Promise<unknown>['catch']>) => promise.catch(...args),
    finally: (...args: Parameters<Promise<unknown>['finally']>) => promise.finally(...args),
    orderBy: () => ({
      limit: () => promise,
    }),
  }
}

vi.mock('./db/client', () => ({
  db: {},
  dbAdmin: {
    select: () => ({
      from: () => ({
        where: (...args: unknown[]) => makeChain(mockDbAdminWhere(...args)),
      }),
    }),
  },
}))

vi.mock('./db/with-tenant', () => ({
  withTenant: mockWithTenant,
}))

vi.mock('./services/sqs', () => ({
  enqueueAutoBatchFollowup: mockSqsSend,
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockAnthropicCreate }
  },
}))

const { handler } = await import('./handler')

function makeSqsEvent(body: unknown): SQSEvent {
  return {
    Records: [
      {
        messageId: 'sqs-msg-1',
        receiptHandle: 'h',
        body: JSON.stringify(body),
        attributes: {
          ApproximateReceiveCount: '1',
          SentTimestamp: '1',
          SenderId: 's',
          ApproximateFirstReceiveTimestamp: '1',
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

function regenJob(overrides: Record<string, unknown> = {}) {
  return {
    jobType: 'draft',
    conversationId: CONVERSATION_ID,
    triggerType: 'regenerate',
    instruction: 'use ¥800 for OP-09',
    ...overrides,
  }
}

function makeAnthropicResponse(text = 'New draft text including ¥800.') {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: 'claude-haiku-4-5-20251001',
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }
}

function buildReadTx({
  latestInboundId = MESSAGE_ID,
  unansweredResult = [{ body: 'How much is OP-09?' }],
  historyResult = [{ direction: 'inbound', body: 'How much is OP-09?', messageType: 'text' }],
}: {
  latestInboundId?: string | null
  unansweredResult?: Array<{ body: string }>
  historyResult?: Array<{ direction: string; body: string; messageType: string }>
} = {}) {
  let n = 0
  return {
    select: vi.fn(() => {
      n++
      if (n === 1) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(() =>
                  Promise.resolve(latestInboundId ? [{ id: latestInboundId }] : []),
                ),
              })),
            })),
          })),
        }
      }
      if (n === 2) {
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
      }
      if (n === 3) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => Promise.resolve([{ ts: null }])),
          })),
        }
      }
      if (n === 4) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => Promise.resolve(unansweredResult)),
              })),
            })),
          })),
        }
      }
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve(historyResult)),
            })),
          })),
        })),
      }
    }),
  }
}

function buildWriteTx() {
  // Type the arg so .mock.calls[0][0] resolves to a real type instead of `never`.
  const setMock = vi.fn<(values: Record<string, unknown>) => { where: () => Promise<unknown> }>(
    () => ({ where: vi.fn().mockResolvedValue({ rowCount: 1 }) }),
  )
  return {
    mockTx: {
      update: vi.fn(() => ({ set: setMock })),
    },
    setMock,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSsm.mockResolvedValue(API_KEY)
  // First call: tenant resolve
  // (additional calls inside processDraftJob for follow-up enqueue look up
  // the latest inbound via dbAdmin — overridden per test as needed)
  mockDbAdminWhere.mockResolvedValue([{ tenantId: TENANT_ID }])
  mockSqsSend.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('regenerate: coalesce bypass', () => {
  it('runs even when latest inbound is newer than triggerMessageId (no triggerMessageId on regen)', async () => {
    // The fn doesn't pass triggerMessageId for regenerate, but even if it did,
    // the coalesce check is skipped for triggerType:'regenerate'.
    const readTx = buildReadTx({ latestInboundId: NEWER_INBOUND_ID })
    const { mockTx: writeTx, setMock } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id, fn) => fn(readTx))
      .mockImplementationOnce(async (_id, fn) => fn(writeTx))
    // After regen success: latest inbound check via dbAdmin (returns same id → no followup)
    mockDbAdminWhere
      .mockResolvedValueOnce([{ tenantId: TENANT_ID }])
      .mockResolvedValueOnce([{ id: NEWER_INBOUND_ID }])
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse())

    await handler(makeSqsEvent(regenJob({ triggerMessageId: MESSAGE_ID })), {} as never, () => {})

    expect(mockAnthropicCreate).toHaveBeenCalledOnce()
    const setArg = setMock.mock.calls[0][0]
    expect(setArg.status).toBe('ready')
    expect(setArg.body).toContain('¥800')
    expect(setArg.error).toBeNull()
  })
})

describe('regenerate: empty unanswered', () => {
  it('does NOT dismiss when unanswered is empty — generates from history only', async () => {
    const readTx = buildReadTx({ unansweredResult: [] })
    const { mockTx: writeTx, setMock } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id, fn) => fn(readTx))
      .mockImplementationOnce(async (_id, fn) => fn(writeTx))
    mockDbAdminWhere
      .mockResolvedValueOnce([{ tenantId: TENANT_ID }])
      .mockResolvedValueOnce([{ id: MESSAGE_ID }])
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse('Regen from history only.'))

    await handler(makeSqsEvent(regenJob()), {} as never, () => {})

    expect(mockAnthropicCreate).toHaveBeenCalledOnce()
    const setArg = setMock.mock.calls[0][0]
    expect(setArg.status).toBe('ready')
    expect(setArg.body).toBe('Regen from history only.')
  })
})

describe('regenerate: prompt composition', () => {
  it('includes the OPERATOR_INSTRUCTION block between additional and LANGUAGE_DIRECTIVE', async () => {
    const readTx = buildReadTx()
    const { mockTx: writeTx } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id, fn) => fn(readTx))
      .mockImplementationOnce(async (_id, fn) => fn(writeTx))
    mockDbAdminWhere
      .mockResolvedValueOnce([{ tenantId: TENANT_ID }])
      .mockResolvedValueOnce([{ id: MESSAGE_ID }])
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse())

    await handler(makeSqsEvent(regenJob({ instruction: 'use ¥800' })), {} as never, () => {})

    const callArgs = mockAnthropicCreate.mock.calls[0][0]
    const systemBlocks = callArgs.system as Array<{ text: string }>
    // BASE is first, LANGUAGE_DIRECTIVE is last
    expect(systemBlocks[0].text).toContain('TCG')
    const lastText = systemBlocks[systemBlocks.length - 1].text
    expect(lastText.toLowerCase()).toContain('language')
    // Operator block sits between
    const opIdx = systemBlocks.findIndex((b) =>
      b.text.includes('## Operator instruction for this draft'),
    )
    expect(opIdx).toBeGreaterThan(0)
    expect(opIdx).toBe(systemBlocks.length - 2)
    expect(systemBlocks[opIdx].text).toContain('use ¥800')
  })

  it('does NOT include OPERATOR_INSTRUCTION block when instruction is empty (regression)', async () => {
    const readTx = buildReadTx()
    const { mockTx: writeTx } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id, fn) => fn(readTx))
      .mockImplementationOnce(async (_id, fn) => fn(writeTx))
    mockDbAdminWhere
      .mockResolvedValueOnce([{ tenantId: TENANT_ID }])
      .mockResolvedValueOnce([{ id: MESSAGE_ID }])
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse())

    await handler(makeSqsEvent(regenJob({ instruction: '   ' })), {} as never, () => {})

    const callArgs = mockAnthropicCreate.mock.calls[0][0]
    const systemBlocks = callArgs.system as Array<{ text: string }>
    expect(systemBlocks.find((b) => b.text.includes('## Operator instruction'))).toBeUndefined()
  })
})

describe('regenerate: failure path keeps body', () => {
  it('writes status=ready + error + no body field when Anthropic throws', async () => {
    const readTx = buildReadTx()
    const { mockTx: writeTx, setMock } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id, fn) => fn(readTx))
      .mockImplementationOnce(async (_id, fn) => fn(writeTx))
    // Use a non-retryable 4xx so the test doesn't burn the retry budget (13s).
    const err = new Error('upstream broken') as Error & { status: number }
    err.status = 400
    mockAnthropicCreate.mockRejectedValue(err)

    await handler(makeSqsEvent(regenJob()), {} as never, () => {})

    const setArg = setMock.mock.calls[0][0]
    expect(setArg.status).toBe('ready')
    // status 400 → bad_request per anthropic error mapping in handler
    expect(setArg.error).toBe('bad_request')
    expect(setArg).not.toHaveProperty('body')
    expect(setArg).not.toHaveProperty('model')
    // updatedAt must be set so the webhook stale-pending guard releases.
    expect(setArg.updatedAt).toBeInstanceOf(Date)
  })
})

describe('regenerate: self-enqueue followup', () => {
  it('enqueues auto-batch when a newer inbound arrived during regenerate', async () => {
    const readTx = buildReadTx({ latestInboundId: MESSAGE_ID })
    const { mockTx: writeTx } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id, fn) => fn(readTx))
      .mockImplementationOnce(async (_id, fn) => fn(writeTx))
    // After write: latest inbound is now NEWER (different from MESSAGE_ID).
    mockDbAdminWhere
      .mockResolvedValueOnce([{ tenantId: TENANT_ID }])
      .mockResolvedValueOnce([{ id: NEWER_INBOUND_ID }])
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse())

    await handler(makeSqsEvent(regenJob()), {} as never, () => {})

    expect(mockSqsSend).toHaveBeenCalledOnce()
    const arg = mockSqsSend.mock.calls[0][0] as {
      conversationId: string
      triggerMessageId: string
    }
    expect(arg.conversationId).toBe(CONVERSATION_ID)
    expect(arg.triggerMessageId).toBe(NEWER_INBOUND_ID)
  })

  it('does NOT enqueue followup when latest inbound is unchanged', async () => {
    const readTx = buildReadTx({ latestInboundId: MESSAGE_ID })
    const { mockTx: writeTx } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id, fn) => fn(readTx))
      .mockImplementationOnce(async (_id, fn) => fn(writeTx))
    mockDbAdminWhere
      .mockResolvedValueOnce([{ tenantId: TENANT_ID }])
      .mockResolvedValueOnce([{ id: MESSAGE_ID }])
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse())

    await handler(makeSqsEvent(regenJob()), {} as never, () => {})

    expect(mockSqsSend).not.toHaveBeenCalled()
  })

  it('does NOT enqueue followup on regenerate failure', async () => {
    const readTx = buildReadTx()
    const { mockTx: writeTx } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id, fn) => fn(readTx))
      .mockImplementationOnce(async (_id, fn) => fn(writeTx))
    const err = new Error('boom') as Error & { status: number }
    err.status = 400
    mockAnthropicCreate.mockRejectedValue(err)

    await handler(makeSqsEvent(regenJob()), {} as never, () => {})

    expect(mockSqsSend).not.toHaveBeenCalled()
  })
})
