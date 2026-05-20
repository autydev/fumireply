import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CONVERSATION_ID = 'cccccccc-cccc-4ccc-9ccc-cccccccccccc'
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa'
const API_KEY = 'test-anthropic-api-key'

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
  default: class MockAnthropic {
    messages = { create: mockAnthropicCreate }
  },
}))

const { processSummaryJob } = await import('./summary')

function makeSummaryBody(conversationId = CONVERSATION_ID) {
  return { jobType: 'summary' as const, conversationId, enqueuedAt: new Date().toISOString() }
}

function makeConvoTx(
  summary: string | null = null,
  lastSummarizedAt: Date | null = null,
  msgs: Array<{ direction: string; body: string; timestamp: Date }> = [],
) {
  let callCount = 0
  return {
    select: vi.fn(() => {
      callCount++
      const n = callCount
      if (n === 1) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => Promise.resolve([{ summary, lastSummarizedAt }])),
          })),
        }
      }
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve(msgs)),
            })),
          })),
        })),
      }
    }),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve({ rowCount: 1 })),
      })),
    })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSsm.mockResolvedValue(API_KEY)
  mockDbAdminWhere.mockResolvedValue([{ tenantId: TENANT_ID }])
})

afterEach(() => {
  vi.clearAllMocks()
  delete process.env.SUMMARY_PIPELINE_ENABLED
})

describe('processSummaryJob — validation', () => {
  it('returns early on invalid body (bad UUID)', async () => {
    await processSummaryJob({ jobType: 'summary', conversationId: 'not-a-uuid' })
    expect(mockDbAdminWhere).not.toHaveBeenCalled()
  })

  it('returns early on wrong jobType', async () => {
    await processSummaryJob({ jobType: 'draft', conversationId: CONVERSATION_ID })
    expect(mockDbAdminWhere).not.toHaveBeenCalled()
  })
})

describe('processSummaryJob — pipeline disabled', () => {
  it('returns immediately when SUMMARY_PIPELINE_ENABLED=false', async () => {
    process.env.SUMMARY_PIPELINE_ENABLED = 'false'
    await processSummaryJob(makeSummaryBody())
    expect(mockDbAdminWhere).not.toHaveBeenCalled()
    expect(mockAnthropicCreate).not.toHaveBeenCalled()
  })
})

describe('processSummaryJob — conversation not found', () => {
  it('returns early when conversation not found via dbAdmin', async () => {
    mockDbAdminWhere.mockResolvedValue([])
    await processSummaryJob(makeSummaryBody())
    expect(mockWithTenant).not.toHaveBeenCalled()
  })
})

describe('processSummaryJob — idempotency (below threshold)', () => {
  it('skips summarization when char count below threshold', async () => {
    const shortMsgs = [
      { direction: 'inbound', body: 'Hi', timestamp: new Date() },
      { direction: 'outbound', body: 'Hello!', timestamp: new Date() },
    ]
    const readTx = makeConvoTx(null, null, shortMsgs)
    mockWithTenant.mockImplementationOnce(async (_: string, fn: (tx: unknown) => unknown) =>
      fn(readTx),
    )

    await processSummaryJob(makeSummaryBody())

    expect(mockAnthropicCreate).not.toHaveBeenCalled()
  })

  it('skips on second call when no new messages above threshold', async () => {
    // First call: already summarized at recent timestamp, no new messages since
    const now = new Date()
    const readTx = makeConvoTx('Previous summary', now, [])
    mockWithTenant.mockImplementationOnce(async (_: string, fn: (tx: unknown) => unknown) =>
      fn(readTx),
    )

    await processSummaryJob(makeSummaryBody())

    expect(mockAnthropicCreate).not.toHaveBeenCalled()
  })
})

describe('processSummaryJob — successful summarization', () => {
  it('calls Anthropic and updates conversations.summary', async () => {
    const longBody = 'x'.repeat(2001)
    const msgs = [
      { direction: 'inbound', body: longBody, timestamp: new Date('2026-01-01') },
    ]
    const readTx = makeConvoTx(null, null, msgs)
    const writeTx = makeConvoTx()

    mockWithTenant
      .mockImplementationOnce(async (_: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_: string, fn: (tx: unknown) => unknown) => fn(writeTx))

    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Customer asked about cards.' }],
      usage: { input_tokens: 50, output_tokens: 10 },
    })

    await processSummaryJob(makeSummaryBody())

    expect(mockAnthropicCreate).toHaveBeenCalledOnce()
    // Verify update was called
    expect(writeTx.update).toHaveBeenCalledOnce()
    const setArgs = writeTx.update.mock.results[0].value.set.mock.calls[0][0]
    expect(setArgs.summary).toBe('Customer asked about cards.')
    expect(setArgs.lastSummarizedAt).toEqual(new Date('2026-01-01'))
  })

  it('incorporates existing summary in the prompt', async () => {
    const longBody = 'x'.repeat(2001)
    const msgs = [{ direction: 'inbound', body: longBody, timestamp: new Date() }]
    const readTx = makeConvoTx('Old summary', null, msgs)
    const writeTx = makeConvoTx()

    mockWithTenant
      .mockImplementationOnce(async (_: string, fn: (tx: unknown) => unknown) => fn(readTx))
      .mockImplementationOnce(async (_: string, fn: (tx: unknown) => unknown) => fn(writeTx))

    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Updated summary.' }],
      usage: { input_tokens: 60, output_tokens: 10 },
    })

    await processSummaryJob(makeSummaryBody())

    expect(mockAnthropicCreate).toHaveBeenCalledOnce()
    const createCall = mockAnthropicCreate.mock.calls[0][0]
    expect(createCall.messages[0].content).toContain('Old summary')
    expect(createCall.messages[0].content).toContain('New messages to incorporate')
  })
})

describe('processSummaryJob — Anthropic failure', () => {
  it('throws on Anthropic error so SQS retries', async () => {
    const longBody = 'x'.repeat(2001)
    const msgs = [{ direction: 'inbound', body: longBody, timestamp: new Date() }]
    const readTx = makeConvoTx(null, null, msgs)

    mockWithTenant.mockImplementationOnce(async (_: string, fn: (tx: unknown) => unknown) =>
      fn(readTx),
    )

    // 400-level errors are thrown immediately (no retry delay) but still propagate
    // so SQS can retry the whole job message.
    const err = new Error('Anthropic 400') as Error & { status: number }
    err.status = 400
    mockAnthropicCreate.mockRejectedValue(err)

    await expect(processSummaryJob(makeSummaryBody())).rejects.toThrow('Anthropic 400')
  })
})
