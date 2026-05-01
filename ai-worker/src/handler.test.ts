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

function makeSqsEvent(body: unknown): SQSEvent {
  return {
    Records: [
      {
        messageId: 'sqs-msg-1',
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

// Build mock tx for use inside withTenant
function buildMockTx({
  messageResult = [
    {
      body: 'Do you have Charizard?',
      messageType: 'text',
      conversationId: CONVERSATION_ID,
    },
  ],
  historyResult = [
    { direction: 'inbound', body: 'Do you have Charizard?', messageType: 'text' },
  ],
  updateWhere = vi.fn().mockResolvedValue({ rowCount: 1 }),
}: {
  messageResult?: Array<{ body: string; messageType: string; conversationId: string }>
  historyResult?: Array<{ direction: string; body: string; messageType: string }>
  updateWhere?: ReturnType<typeof vi.fn>
} = {}) {
  let selectCallCount = 0

  const mockTx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          selectCallCount++
          if (selectCallCount === 1) {
            // First select: get message details
            return Promise.resolve(messageResult)
          }
          // Second select: get conversation history
          return {
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve(historyResult)),
            })),
          }
        }),
      })),
    })),
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
    const event = makeSqsEvent('not-valid-json')
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
    const { mockTx, updateWhere } = buildMockTx()
    mockWithTenant.mockImplementation(async (_tenantId: string, fn: (tx: unknown) => unknown) => {
      return fn(mockTx)
    })
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse())

    await handler(makeSqsEvent({ messageId: MESSAGE_ID }), {} as never, () => {})

    expect(mockWithTenant).toHaveBeenCalledWith(TENANT_ID, expect.any(Function))
    expect(mockAnthropicCreate).toHaveBeenCalledOnce()
    expect(updateWhere).toHaveBeenCalledOnce()
    const setCall = mockTx.update.mock.results[0].value.set.mock.calls[0][0]
    expect(setCall.status).toBe('ready')
    expect(setCall.body).toBe('Test reply draft.')
    expect(setCall.model).toBe('claude-haiku-4-5-20251001')
    // prompt_tokens = input_tokens + cache_creation + cache_read = 100 + 80 + 0 = 180
    expect(setCall.promptTokens).toBe(180)
    expect(setCall.completionTokens).toBe(20)
  })

  it('does NOT call Meta Send API (FR-026 Human-in-the-Loop)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { mockTx } = buildMockTx()
    mockWithTenant.mockImplementation(async (_tenantId: string, fn: (tx: unknown) => unknown) => {
      return fn(mockTx)
    })
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse())

    await handler(makeSqsEvent({ messageId: MESSAGE_ID }), {} as never, () => {})

    // fetch must not be called with Meta graph API domain
    const metaCalls = fetchSpy.mock.calls.filter((args) =>
      String(args[0]).includes('graph.facebook.com'),
    )
    expect(metaCalls).toHaveLength(0)
    fetchSpy.mockRestore()
  })
})

describe('handler — non-text message (sticker)', () => {
  it('skips Anthropic call for sticker message_type', async () => {
    const { mockTx } = buildMockTx({
      messageResult: [{ body: '', messageType: 'sticker', conversationId: CONVERSATION_ID }],
    })
    mockWithTenant.mockImplementation(async (_tenantId: string, fn: (tx: unknown) => unknown) => {
      return fn(mockTx)
    })

    await handler(makeSqsEvent({ messageId: MESSAGE_ID }), {} as never, () => {})

    expect(mockAnthropicCreate).not.toHaveBeenCalled()
  })
})

describe('handler — Anthropic API errors', () => {
  it('updates ai_drafts with auth_failed on 401', async () => {
    const { mockTx, updateWhere } = buildMockTx()
    mockWithTenant.mockImplementation(async (_tenantId: string, fn: (tx: unknown) => unknown) => {
      return fn(mockTx)
    })
    mockAnthropicCreate.mockRejectedValue(makeApiError(401, 'Unauthorized'))

    await handler(makeSqsEvent({ messageId: MESSAGE_ID }), {} as never, () => {})

    expect(updateWhere).toHaveBeenCalledOnce()
    const setCall = mockTx.update.mock.results[0].value.set.mock.calls[0][0]
    expect(setCall.status).toBe('failed')
    expect(setCall.error).toBe('auth_failed')
  })

  it('retries on 429 and succeeds on second attempt', async () => {
    vi.useFakeTimers()
    const { mockTx, updateWhere } = buildMockTx()
    mockWithTenant.mockImplementation(async (_tenantId: string, fn: (tx: unknown) => unknown) => {
      return fn(mockTx)
    })
    mockAnthropicCreate
      .mockRejectedValueOnce(makeApiError(429, 'Rate limited'))
      .mockResolvedValue(makeAnthropicResponse())

    const handlerPromise = handler(makeSqsEvent({ messageId: MESSAGE_ID }), {} as never, () => {})
    // Advance past first retry delay (1000ms)
    await vi.runAllTimersAsync()
    await handlerPromise

    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2)
    const setCall = mockTx.update.mock.results[0].value.set.mock.calls[0][0]
    expect(setCall.status).toBe('ready')
    vi.useRealTimers()
  })

  it('updates ai_drafts with server_error after 3 consecutive 503 failures', async () => {
    vi.useFakeTimers()
    const { mockTx, updateWhere } = buildMockTx()
    mockWithTenant.mockImplementation(async (_tenantId: string, fn: (tx: unknown) => unknown) => {
      return fn(mockTx)
    })
    mockAnthropicCreate.mockRejectedValue(makeApiError(503, 'Service Unavailable'))

    const handlerPromise = handler(makeSqsEvent({ messageId: MESSAGE_ID }), {} as never, () => {})
    await vi.runAllTimersAsync()
    await handlerPromise

    // 4 attempts: 1 initial + 3 retries
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(4)
    expect(updateWhere).toHaveBeenCalledOnce()
    const setCall = mockTx.update.mock.results[0].value.set.mock.calls[0][0]
    expect(setCall.status).toBe('failed')
    expect(setCall.error).toBe('server_error')
    vi.useRealTimers()
  })
})

describe('handler — prompt building', () => {
  it('builds prompt with conversation history (last 5, chronological)', async () => {
    const history = [
      { direction: 'inbound', body: 'Hi', messageType: 'text' },
      { direction: 'outbound', body: 'Hello!', messageType: 'text' },
      { direction: 'inbound', body: 'Do you have Charizard?', messageType: 'text' },
    ]
    const { mockTx } = buildMockTx({ historyResult: history })
    mockWithTenant.mockImplementation(async (_tenantId: string, fn: (tx: unknown) => unknown) => {
      return fn(mockTx)
    })
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
