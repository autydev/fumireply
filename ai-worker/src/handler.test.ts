import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SQSEvent } from 'aws-lambda'

// Proper UUID v4 format required by Zod v4: version nibble=4, variant nibble=8/9/a/b
const MESSAGE_ID = '11111111-1111-4111-9111-111111111111'
const OTHER_MESSAGE_ID = '22222222-2222-4222-9222-222222222222'
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

// Default conversation-scoped draft job (coalesce: trigger === latest inbound).
function draftJob(overrides: Record<string, unknown> = {}) {
  return {
    jobType: 'draft',
    conversationId: CONVERSATION_ID,
    triggerMessageId: MESSAGE_ID,
    ...overrides,
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

// Build read transaction mock for the conversation-scoped draft flow.
// Query order inside processDraftJob's read tx:
//   1. latest inbound text message (coalesce)
//   2. conversation settings + page custom_prompt (leftJoin)
//   3. last outbound timestamp (008: typed column select + orderBy + limit 1)
//   4. unanswered batch (inbound text after last outbound)
//   5. context history (text after summary cursor)
function buildReadTx({
  latestInboundId = MESSAGE_ID,
  settingsResult = [
    {
      summary: null,
      lastSummarizedAt: null,
      tonePreset: null,
      customPrompt: null,
      pageCustomPrompt: null,
    },
  ],
  lastOutboundResult = [{ ts: null }],
  unansweredResult = [{ body: 'Do you have Charizard?' }],
  historyResult = [{ direction: 'inbound', body: 'Do you have Charizard?', messageType: 'text' }],
}: {
  latestInboundId?: string | null
  settingsResult?: Array<{
    summary: string | null
    lastSummarizedAt: Date | null
    tonePreset: string | null
    customPrompt: string | null
    pageCustomPrompt: string | null
  }>
  lastOutboundResult?: Array<{ ts: Date | null }>
  unansweredResult?: Array<{ body: string }>
  historyResult?: Array<{ direction: string; body: string; messageType: string }>
} = {}) {
  let selectCallCount = 0

  // 008: spies for the boundary query chain so tests can assert the query is
  // issued as a typed-column select with orderBy + limit(1) (not a raw max()).
  const boundaryLimit = vi.fn(() => Promise.resolve(lastOutboundResult))
  const boundaryOrderBy = vi.fn(() => ({ limit: boundaryLimit }))

  const tx = {
    select: vi.fn(() => {
      selectCallCount++
      const n = selectCallCount

      if (n === 1) {
        // latest inbound text: from().where().orderBy().limit()
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
      } else if (n === 2) {
        // settings: from().leftJoin().where()
        return {
          from: vi.fn(() => ({
            leftJoin: vi.fn(() => ({
              where: vi.fn(() => Promise.resolve(settingsResult)),
            })),
          })),
        }
      } else if (n === 3) {
        // last outbound ts (008): from().where().orderBy().limit()
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({ orderBy: boundaryOrderBy })),
          })),
        }
      } else if (n === 4) {
        // unanswered batch: from().where().orderBy().limit()
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => Promise.resolve(unansweredResult)),
              })),
            })),
          })),
        }
      } else {
        // context history: from().where().orderBy().limit()
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => Promise.resolve(historyResult)),
              })),
            })),
          })),
        }
      }
    }),
  }

  return Object.assign(tx, { boundaryOrderBy, boundaryLimit })
}

// Build write transaction mock (update ai_drafts — generate result or dismiss)
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

  it('skips processing when conversationId is missing from body', async () => {
    await handler(makeSqsEvent({ wrong: 'field' }), {} as never, () => {})
    expect(mockDbAdminWhere).not.toHaveBeenCalled()
  })
})

describe('handler — conversation not found', () => {
  it('returns without calling withTenant when conversation is not in DB', async () => {
    mockDbAdminWhere.mockResolvedValue([])
    await handler(makeSqsEvent(draftJob()), {} as never, () => {})
    expect(mockWithTenant).not.toHaveBeenCalled()
  })
})

describe('handler — normal batch draft', () => {
  it('calls Anthropic and updates the active draft with ready status', async () => {
    const readTx = buildReadTx()
    const { mockTx: writeTx, updateWhere } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx))
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse())

    await handler(makeSqsEvent(draftJob()), {} as never, () => {})

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

    await handler(makeSqsEvent(draftJob(), 2), {} as never, () => {})

    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2)
    expect(mockWithTenant).toHaveBeenCalledTimes(4)
  })

  it('does NOT call Meta Send API (Human-in-the-Loop)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const readTx = buildReadTx()
    const { mockTx: writeTx } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx))
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse())

    await handler(makeSqsEvent(draftJob()), {} as never, () => {})

    const metaCalls = fetchSpy.mock.calls.filter((args) =>
      String(args[0]).includes('graph.facebook.com'),
    )
    expect(metaCalls).toHaveLength(0)
    fetchSpy.mockRestore()
  })
})

describe('handler — 008 regression: conversation WITH outbound messages (#75)', () => {
  // Before 008 the boundary query used a raw sql`max(timestamp)` fragment that
  // returned a string at runtime, crashing PgTimestamp.mapToDriverValue in the
  // following gt() comparison whenever the conversation had >= 1 outbound.
  it('generates a ready draft when the conversation has an outbound message', async () => {
    const readTx = buildReadTx({
      lastOutboundResult: [{ ts: new Date('2026-06-01T00:00:00Z') }],
    })
    const { mockTx: writeTx, updateWhere } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx))
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse())

    await handler(makeSqsEvent(draftJob()), {} as never, () => {})

    expect(mockAnthropicCreate).toHaveBeenCalledOnce()
    expect(updateWhere).toHaveBeenCalledOnce()
    const setCall = writeTx.update.mock.results[0].value.set.mock.calls[0][0]
    expect(setCall.status).toBe('ready')
  })

  it('issues the boundary query as a typed-column select with orderBy + limit(1)', async () => {
    const readTx = buildReadTx({
      lastOutboundResult: [{ ts: new Date('2026-06-01T00:00:00Z') }],
    })
    const { mockTx: writeTx } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx))
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse())

    await handler(makeSqsEvent(draftJob()), {} as never, () => {})

    expect(readTx.boundaryOrderBy).toHaveBeenCalledOnce()
    expect(readTx.boundaryLimit).toHaveBeenCalledWith(1)
  })
})

describe('handler — coalesce (debounce)', () => {
  it('skips generation when a newer inbound message exists (superseded)', async () => {
    // Latest inbound is OTHER_MESSAGE_ID, but this job was triggered by MESSAGE_ID.
    const readTx = buildReadTx({ latestInboundId: OTHER_MESSAGE_ID })
    mockWithTenant.mockImplementationOnce(
      async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx),
    )

    await handler(makeSqsEvent(draftJob()), {} as never, () => {})

    expect(mockAnthropicCreate).not.toHaveBeenCalled()
    expect(mockWithTenant).toHaveBeenCalledTimes(1) // read only, no write
  })
})

describe('handler — no unanswered messages', () => {
  it('dismisses the active draft without calling Anthropic', async () => {
    const readTx = buildReadTx({ unansweredResult: [] })
    const { mockTx: writeTx, updateWhere } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx))

    await handler(makeSqsEvent(draftJob()), {} as never, () => {})

    expect(mockAnthropicCreate).not.toHaveBeenCalled()
    expect(mockWithTenant).toHaveBeenCalledTimes(2) // read + dismiss
    const setCall = writeTx.update.mock.results[0].value.set.mock.calls[0][0]
    expect(setCall.status).toBe('dismissed')
  })
})

describe('handler — Anthropic API errors', () => {
  it('updates the active draft with auth_failed on 401', async () => {
    const readTx = buildReadTx()
    const { mockTx: writeTx, updateWhere } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx))
    mockAnthropicCreate.mockRejectedValue(makeApiError(401, 'Unauthorized'))

    await handler(makeSqsEvent(draftJob()), {} as never, () => {})

    expect(updateWhere).toHaveBeenCalledOnce()
    const setCall = writeTx.update.mock.results[0].value.set.mock.calls[0][0]
    expect(setCall.status).toBe('failed')
    expect(setCall.error).toBe('auth_failed')
  })

  it('retries on 429 and succeeds on second attempt', async () => {
    vi.useFakeTimers()
    const readTx = buildReadTx()
    const { mockTx: writeTx } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx))
    mockAnthropicCreate
      .mockRejectedValueOnce(makeApiError(429, 'Rate limited'))
      .mockResolvedValue(makeAnthropicResponse())

    const handlerPromise = handler(makeSqsEvent(draftJob()), {} as never, () => {})
    await vi.runAllTimersAsync()
    await handlerPromise

    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2)
    const setCall = writeTx.update.mock.results[0].value.set.mock.calls[0][0]
    expect(setCall.status).toBe('ready')
    vi.useRealTimers()
  })

  it('updates the active draft with server_error after 3 consecutive 503 failures', async () => {
    vi.useFakeTimers()
    const readTx = buildReadTx()
    const { mockTx: writeTx, updateWhere } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx))
    mockAnthropicCreate.mockRejectedValue(makeApiError(503, 'Service Unavailable'))

    const handlerPromise = handler(makeSqsEvent(draftJob()), {} as never, () => {})
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

  it('updates the active draft with unexpected_response_type when content has no text blocks', async () => {
    const readTx = buildReadTx()
    const { mockTx: writeTx, updateWhere } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx))
    mockAnthropicCreate.mockResolvedValue(
      makeAnthropicResponse({ content: [{ type: 'tool_use', id: 'x', name: 'y', input: {} }] }),
    )

    await handler(makeSqsEvent(draftJob()), {} as never, () => {})

    expect(updateWhere).toHaveBeenCalledOnce()
    const setCall = writeTx.update.mock.results[0].value.set.mock.calls[0][0]
    expect(setCall.status).toBe('failed')
    expect(setCall.error).toBe('unexpected_response_type')
  })
})

describe('handler — prompt building', () => {
  it('includes conversation history and the unanswered batch directive', async () => {
    const history = [
      { direction: 'inbound', body: 'Hi', messageType: 'text' },
      { direction: 'outbound', body: 'Hello!', messageType: 'text' },
      { direction: 'inbound', body: 'Do you have Charizard?', messageType: 'text' },
    ]
    const readTx = buildReadTx({
      historyResult: history,
      unansweredResult: [{ body: 'Do you have Charizard?' }, { body: 'And Pikachu?' }],
    })
    const { mockTx: writeTx } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx))
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse())

    await handler(makeSqsEvent(draftJob()), {} as never, () => {})

    const createCall = mockAnthropicCreate.mock.calls[0][0]
    const userContent = createCall.messages[0].content as string
    expect(userContent).toContain('[customer]: Hi')
    expect(userContent).toContain('[operator]: Hello!')
    expect(userContent).toContain('Unanswered customer messages')
    expect(userContent).toContain('- Do you have Charizard?')
    expect(userContent).toContain('- And Pikachu?')
  })
})

describe('handler — SC-007 backward compat (all new columns NULL)', () => {
  it('calls Anthropic with BASE_SYSTEM_PROMPT + LANGUAGE_DIRECTIVE (no additional) when all settings are NULL', async () => {
    const readTx = buildReadTx({
      settingsResult: [
        {
          summary: null,
          lastSummarizedAt: null,
          tonePreset: null,
          customPrompt: null,
          pageCustomPrompt: null,
        },
      ],
    })
    const { mockTx: writeTx } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx))
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse())

    await handler(makeSqsEvent(draftJob()), {} as never, () => {})

    expect(mockAnthropicCreate).toHaveBeenCalledOnce()
    const createCall = mockAnthropicCreate.mock.calls[0][0]
    // 2 blocks: BASE_SYSTEM_PROMPT (cached) + LANGUAGE_DIRECTIVE (always last).
    expect(createCall.system).toHaveLength(2)
    expect(createCall.system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(createCall.system[1].text).toMatch(/Output language rule/)
  })
})

describe('handler — legacy { messageId } jobs', () => {
  it('resolves the conversation and generates a draft', async () => {
    // First dbAdmin call resolves conversationId from messageId; second resolves tenant.
    mockDbAdminWhere
      .mockResolvedValueOnce([{ conversationId: CONVERSATION_ID }])
      .mockResolvedValueOnce([{ tenantId: TENANT_ID }])
    const readTx = buildReadTx()
    const { mockTx: writeTx } = buildWriteTx()
    mockWithTenant
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_id: string, fn: (tx: unknown) => unknown) => fn(writeTx))
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse())

    await handler(makeSqsEvent({ messageId: MESSAGE_ID }), {} as never, () => {})

    expect(mockAnthropicCreate).toHaveBeenCalledOnce()
    const setCall = writeTx.update.mock.results[0].value.set.mock.calls[0][0]
    expect(setCall.status).toBe('ready')
  })
})

describe('handler — summary jobType', () => {
  it('handles summary job: resolves tenant and skips Anthropic when below threshold', async () => {
    let selectCallCount = 0
    mockWithTenant.mockImplementationOnce(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({
        select: vi.fn(() => {
          selectCallCount++
          if (selectCallCount === 1) {
            // conversation row — returns summary + lastSummarizedAt
            return {
              from: vi.fn(() => ({
                where: vi.fn(() => Promise.resolve([{ summary: null, lastSummarizedAt: null }])),
              })),
            }
          }
          // totalChars aggregate — well below 2000 threshold
          return {
            from: vi.fn(() => ({
              where: vi.fn(() => Promise.resolve([{ totalChars: '100' }])),
            })),
          }
        }),
      }),
    )

    await handler(
      makeSqsEvent({
        jobType: 'summary',
        conversationId: CONVERSATION_ID,
        enqueuedAt: new Date().toISOString(),
      }),
      {} as never,
      () => {},
    )

    expect(mockDbAdminWhere).toHaveBeenCalledOnce() // tenant resolved
    expect(mockWithTenant).toHaveBeenCalledOnce() // threshold check ran
    expect(mockAnthropicCreate).not.toHaveBeenCalled() // correctly skipped
  })

  it('handles summary job when SUMMARY_PIPELINE_ENABLED=false without calling dbAdmin', async () => {
    process.env.SUMMARY_PIPELINE_ENABLED = 'false'
    try {
      await handler(
        makeSqsEvent({
          jobType: 'summary',
          conversationId: CONVERSATION_ID,
        }),
        {} as never,
        () => {},
      )

      expect(mockAnthropicCreate).not.toHaveBeenCalled()
      expect(mockDbAdminWhere).not.toHaveBeenCalled()
    } finally {
      delete process.env.SUMMARY_PIPELINE_ENABLED
    }
  })
})
