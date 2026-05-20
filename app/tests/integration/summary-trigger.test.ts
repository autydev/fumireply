// @vitest-environment node
// Unit: maybeEnqueueSummaryJob — disabled / below-threshold / above-threshold / SQS failure

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CONV_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const QUEUE_URL = 'https://sqs.ap-northeast-1.amazonaws.com/123/test-summary-queue'

const { mockWithTenant, mockSqsSend } = vi.hoisted(() => ({
  mockWithTenant: vi.fn(),
  mockSqsSend: vi.fn(),
}))

vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost:5432/test')
vi.stubEnv('DATABASE_URL_SERVICE_ROLE', 'postgresql://test:test@localhost:5432/test')
vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'test-key')
vi.stubEnv('SUPABASE_SECRET_KEY', 'test-secret')
vi.stubEnv('AWS_REGION', 'ap-northeast-1')

vi.mock('~/server/db/client', () => ({ db: {}, dbAdmin: {} }))
vi.mock('~/server/db/with-tenant', () => ({ withTenant: mockWithTenant }))
vi.mock('@aws-sdk/client-sqs', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-sqs')>('@aws-sdk/client-sqs')
  return {
    ...actual,
    SQSClient: class {
      send = mockSqsSend
    },
  }
})

const { maybeEnqueueSummaryJob } = await import('~/server/services/summary-trigger')

function makeTx(totalChars: number) {
  let callCount = 0
  return {
    select: vi.fn(() => {
      callCount++
      if (callCount === 1) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => Promise.resolve([{ lastSummarizedAt: null }])),
          })),
        }
      }
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([{ totalChars }])),
        })),
      }
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.AI_SUMMARY_QUEUE_URL
  delete process.env.SUMMARY_PIPELINE_ENABLED
  delete process.env.SUMMARY_TRIGGER_THRESHOLD_CHARS
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('maybeEnqueueSummaryJob — pipeline disabled', () => {
  it('returns early when AI_SUMMARY_QUEUE_URL is not set', async () => {
    await maybeEnqueueSummaryJob(CONV_ID, TENANT_ID)
    expect(mockWithTenant).not.toHaveBeenCalled()
    expect(mockSqsSend).not.toHaveBeenCalled()
  })

  it('returns early when SUMMARY_PIPELINE_ENABLED=false', async () => {
    process.env.AI_SUMMARY_QUEUE_URL = QUEUE_URL
    process.env.SUMMARY_PIPELINE_ENABLED = 'false'
    await maybeEnqueueSummaryJob(CONV_ID, TENANT_ID)
    expect(mockWithTenant).not.toHaveBeenCalled()
    expect(mockSqsSend).not.toHaveBeenCalled()
  })
})

describe('maybeEnqueueSummaryJob — below threshold', () => {
  it('does not enqueue SQS when char count is below threshold', async () => {
    process.env.AI_SUMMARY_QUEUE_URL = QUEUE_URL
    const tx = makeTx(500)
    mockWithTenant.mockImplementationOnce(async (_: string, fn: (tx: unknown) => unknown) => fn(tx))

    await maybeEnqueueSummaryJob(CONV_ID, TENANT_ID)

    expect(mockWithTenant).toHaveBeenCalledOnce()
    expect(mockSqsSend).not.toHaveBeenCalled()
  })
})

describe('maybeEnqueueSummaryJob — above threshold', () => {
  it('enqueues SQS message with correct body when char count exceeds threshold', async () => {
    process.env.AI_SUMMARY_QUEUE_URL = QUEUE_URL
    const tx = makeTx(2001)
    mockWithTenant.mockImplementationOnce(async (_: string, fn: (tx: unknown) => unknown) => fn(tx))
    mockSqsSend.mockResolvedValue({ MessageId: 'sqs-msg-id' })

    await maybeEnqueueSummaryJob(CONV_ID, TENANT_ID)

    expect(mockSqsSend).toHaveBeenCalledOnce()
    const sendArg = mockSqsSend.mock.calls[0][0]
    const body = JSON.parse(sendArg.input.MessageBody)
    expect(body.jobType).toBe('summary')
    expect(body.conversationId).toBe(CONV_ID)
    expect(typeof body.enqueuedAt).toBe('string')
  })

  it('respects custom SUMMARY_TRIGGER_THRESHOLD_CHARS env var', async () => {
    process.env.AI_SUMMARY_QUEUE_URL = QUEUE_URL
    process.env.SUMMARY_TRIGGER_THRESHOLD_CHARS = '500'
    const tx = makeTx(501)
    mockWithTenant.mockImplementationOnce(async (_: string, fn: (tx: unknown) => unknown) => fn(tx))
    mockSqsSend.mockResolvedValue({})

    await maybeEnqueueSummaryJob(CONV_ID, TENANT_ID)

    expect(mockSqsSend).toHaveBeenCalledOnce()
  })
})

describe('maybeEnqueueSummaryJob — SQS failure', () => {
  it('does not throw when SQS SendMessage fails', async () => {
    process.env.AI_SUMMARY_QUEUE_URL = QUEUE_URL
    const tx = makeTx(2001)
    mockWithTenant.mockImplementationOnce(async (_: string, fn: (tx: unknown) => unknown) => fn(tx))
    mockSqsSend.mockRejectedValue(new Error('SQS unavailable'))

    await expect(maybeEnqueueSummaryJob(CONV_ID, TENANT_ID)).resolves.toBeUndefined()
  })
})
