import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SQSEvent } from 'aws-lambda'

// Proper UUID v4 format required by Zod v4: version nibble=4, variant nibble=8/9/a/b
const MESSAGE_ID = '11111111-1111-4111-9111-111111111111'
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa'
const CONVERSATION_ID = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb'
const API_KEY = 'test-anthropic-api-key'

// --- hoisted mocks ---
const { mockSsm, mockDbAdminWhere, mockWithTenant, mockAnthropicCreate } = vi.hoisted(() => ({
  mockSsm: vi.fn<() => Promise<string>>(),
  mockDbAdminWhere: vi.fn(),
  mockWithTenant: vi.fn(),
  mockAnthropicCreate: vi.fn(),
}))

vi.mock('./services/ssm', () => ({
  getSsmParameter: mockSsm,
  clearSsmCache: vi.fn(),
}))

vi.mock('./db/client', () => ({
  db: {},
  dbAdmin: {
    select: () => ({ from: () => ({ where: mockDbAdminWhere }) }),
  },
}))

vi.mock('./db/with-tenant', () => ({
  withTenant: mockWithTenant,
}))

vi.mock('@anthropic-ai/sdk', () => ({
  // Must be a class (not arrow fn) so `new Anthropic()` works
  default: class MockAnthropic {
    messages = { create: mockAnthropicCreate }
  },
}))

const { handler } = await import('./handler')

// --- helpers ---

function makeSqsEvent(body: unknown, count = 1): SQSEvent {
  const makeRecord = (i: number) => ({
    messageId: `sqs-msg-${i}`,
    receiptHandle: `handle-${i}`,
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
  })
  return { Records: Array.from({ length: count }, (_, i) => makeRecord(i + 1)) }
}

function makeAnthropicResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Test reply draft.' }],
    model: 'claude-haiku-4-5-20251001',
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 80,
      cache_read_input_tokens: 0,
    },
    ...overrides,
  }
}

function makeApiError(status: number, message = 'API error'): Error & { status: number } {
  const err = new Error(message) as Error & { status: number }
  err.status = status
  return err
}

// Build read transaction mock (first withTenant call: get message + history)
function buildReadTx({
  messageResult = [
    { body: 'Do you have Charizard?', messageType: 'text', conversationId: CONVERSATION_ID },
  ],
  historyResult = [{ direction: 'inbound', body: 'Do you have Charizard?', messageType: 'text' }],
}: {
  messageResult?: Array<{ body: string; messageType: string; conversationId: string }>
  historyResult?: Array<{ direction: string; body: string; messageType: string }>
} = {}) {
  let selectCallCount = 0

  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          selectCallCount++
          if (selectCallCount === 1) {
            return Promise.resolve(messageResult)
          }
          return {
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve(historyResult)),
            })),
          }
        }),
      })),
    })),
  }
}

// Build write transaction mock (second withTenant call: update ai_drafts)
function buildWriteTx() {
  const updateWhere = vi.fn().mockResolvedValue({ rowCount: 1 })
  const mockTx = {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: updateWhere,
      })),
    })),
  }
  return { mockTx, updateWhere }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSsm.mockResolvedValue(API_KEY)
  mockDbAdminWhere.mockResolvedValue([{ tenantId: TENANT_ID }])
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('handler — SQS parse', () => {
  it('skips processing on invalid JSON body', async () => {
    const event = makeSqsEvent({})
    event.Records[0].body = 'not-valid-json'
    await handler(event, {} as never, () => {})
    expect(mockDbAdminWhere).not.toHaveBeenCalled()
  })

  it('skips processing when messageId is missing from body', async () => {
    await handler(makeSqsEvent({ wrong: 'field' }), {} as never, () => {})
    expect(mockDbAdminWhere).not.toHaveBeenCalled()
  })
})

describe('handler — message not found', () => {
  it('returns without calling withTenant when message is not in DB', async () => {
    mockDbAdminWhere.mockResolvedValue([])
    await handler(makeSqsEvent({ messageId: MESSAGE_ID }), {} as never, () => {})
    expect(mockWithTenant).not.toHaveBeenCalled()
  })
})

describe('handler — normal text message', () => {
  it('calls Anthropic and updates ai_drafts with ready status', async () => {
    const readTx = buildReadTx()
    const { mockTx: writeTx, updateWhere } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx))
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse())

    await handler(makeSqsEvent({ messageId: MESSAGE_ID }), {} as never, () => {})

    expect(mockWithTenant).toHaveBeenCalledTimes(2)
    expect(mockWithTenant).toHaveBeenNthCalledWith(1, TENANT_ID, expect.any(Function))
    expect(mockWithTenant).toHaveBeenNthCalledWith(2, TENANT_ID, expect.any(Function))
    expect(mockAnthropicCreate).toHaveBeenCalledOnce()
    expect(updateWhere).toHaveBeenCalledOnce()

    const setCall = writeTx.update.mock.results[0].value.set.mock.calls[0][0]
    expect(setCall.status).toBe('ready')
    expect(setCall.body).toBe('Test reply draft.')
    expect(setCall.model).toBe('claude-haiku-4-5-20251001')
    // prompt_tokens = input_tokens + cache_creation + cache_read = 100 + 80 + 0 = 180
    expect(setCall.promptTokens).toBe(180)
    expect(setCall.completionTokens).toBe(20)
  })

  it('processes all records in a multi-record SQS event', async () => {
    const readTx1 = buildReadTx()
    const { mockTx: writeTx1 } = buildWriteTx()
    const readTx2 = buildReadTx()
    const { mockTx: writeTx2 } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx1))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx1))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx2))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx2))
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse())
    mockDbAdminWhere.mockResolvedValue([{ tenantId: TENANT_ID }])

    await handler(makeSqsEvent({ messageId: MESSAGE_ID }, 2), {} as never, () => {})

    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2)
    expect(mockWithTenant).toHaveBeenCalledTimes(4)
  })

  it('does NOT call Meta Send API (FR-026 Human-in-the-Loop)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const readTx = buildReadTx()
    const { mockTx: writeTx } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx))
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse())

    await handler(makeSqsEvent({ messageId: MESSAGE_ID }), {} as never, () => {})

    const metaCalls = fetchSpy.mock.calls.filter((args) =>
      String(args[0]).includes('graph.facebook.com'),
    )
    expect(metaCalls).toHaveLength(0)
    fetchSpy.mockRestore()
  })
})

describe('handler — non-text message (sticker)', () => {
  it('skips Anthropic call for sticker message_type', async () => {
    const readTx = buildReadTx({
      messageResult: [{ body: '', messageType: 'sticker', conversationId: CONVERSATION_ID }],
    })
    mockWithTenant.mockImplementationOnce(
      async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx),
    )

    await handler(makeSqsEvent({ messageId: MESSAGE_ID }), {} as never, () => {})

    expect(mockAnthropicCreate).not.toHaveBeenCalled()
    expect(mockWithTenant).toHaveBeenCalledTimes(1) // only read tx, no write tx
  })
})

describe('handler — Anthropic API errors', () => {
  it('updates ai_drafts with auth_failed on 401', async () => {
    const readTx = buildReadTx()
    const { mockTx: writeTx, updateWhere } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx))
    mockAnthropicCreate.mockRejectedValue(makeApiError(401, 'Unauthorized'))

    await handler(makeSqsEvent({ messageId: MESSAGE_ID }), {} as never, () => {})

    expect(updateWhere).toHaveBeenCalledOnce()
    const setCall = writeTx.update.mock.results[0].value.set.mock.calls[0][0]
    expect(setCall.status).toBe('failed')
    expect(setCall.error).toBe('auth_failed')
  })

  it('retries on 429 and succeeds on second attempt', async () => {
    vi.useFakeTimers()
    const readTx = buildReadTx()
    const { mockTx: writeTx, updateWhere } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx))
    mockAnthropicCreate
      .mockRejectedValueOnce(makeApiError(429, 'Rate limited'))
      .mockResolvedValue(makeAnthropicResponse())

    const handlerPromise = handler(makeSqsEvent({ messageId: MESSAGE_ID }), {} as never, () => {})
    await vi.runAllTimersAsync()
    await handlerPromise

    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2)
    const setCall = writeTx.update.mock.results[0].value.set.mock.calls[0][0]
    expect(setCall.status).toBe('ready')
    vi.useRealTimers()
  })

  it('updates ai_drafts with server_error after 3 consecutive 503 failures', async () => {
    vi.useFakeTimers()
    const readTx = buildReadTx()
    const { mockTx: writeTx, updateWhere } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx))
    mockAnthropicCreate.mockRejectedValue(makeApiError(503, 'Service Unavailable'))

    const handlerPromise = handler(makeSqsEvent({ messageId: MESSAGE_ID }), {} as never, () => {})
    await vi.runAllTimersAsync()
    await handlerPromise

    // 4 attempts: 1 initial + 3 retries
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(4)
    expect(updateWhere).toHaveBeenCalledOnce()
    const setCall = writeTx.update.mock.results[0].value.set.mock.calls[0][0]
    expect(setCall.status).toBe('failed')
    expect(setCall.error).toBe('server_error')
    vi.useRealTimers()
  })

  it('updates ai_drafts with unexpected_response_type when content has no text blocks', async () => {
    const readTx = buildReadTx()
    const { mockTx: writeTx, updateWhere } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx))
    mockAnthropicCreate.mockResolvedValue(
      makeAnthropicResponse({ content: [{ type: 'tool_use', id: 'x', name: 'y', input: {} }] }),
    )

    await handler(makeSqsEvent({ messageId: MESSAGE_ID }), {} as never, () => {})

    expect(updateWhere).toHaveBeenCalledOnce()
    const setCall = writeTx.update.mock.results[0].value.set.mock.calls[0][0]
    expect(setCall.status).toBe('failed')
    expect(setCall.error).toBe('unexpected_response_type')
  })
})

describe('handler — prompt building', () => {
  it('builds prompt with conversation history (last 5, chronological)', async () => {
    const history = [
      { direction: 'inbound', body: 'Hi', messageType: 'text' },
      { direction: 'outbound', body: 'Hello!', messageType: 'text' },
      { direction: 'inbound', body: 'Do you have Charizard?', messageType: 'text' },
    ]
    const readTx = buildReadTx({ historyResult: history })
    const { mockTx: writeTx } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx))
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse())

    await handler(makeSqsEvent({ messageId: MESSAGE_ID }), {} as never, () => {})

    const createCall = mockAnthropicCreate.mock.calls[0][0]
    const userContent = createCall.messages[0].content as string
    expect(userContent).toContain('[customer]: Hi')
    expect(userContent).toContain('[operator]: Hello!')
    expect(userContent).toContain('[customer]: Do you have Charizard?')
    expect(userContent).toContain('Generate a reply to the latest customer message.')
  })
})
