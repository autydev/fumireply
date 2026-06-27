// Set required env vars before any module imports
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test'
process.env.DATABASE_URL_SERVICE_ROLE = 'postgresql://test:test@localhost:5432/test'
process.env.SUPABASE_URL = 'https://test.supabase.co'
process.env.SUPABASE_PUBLISHABLE_KEY = 'test-key'
process.env.SUPABASE_SECRET_KEY = 'test-secret'
process.env.META_APP_ID = 'test-app-id'
process.env.META_APP_SECRET_SSM_KEY = '/test/meta/secret'
process.env.WEBHOOK_VERIFY_TOKEN_SSM_KEY = '/test/webhook/token'
process.env.ANTHROPIC_API_KEY_SSM_KEY = '/test/anthropic/key'
process.env.AWS_REGION = 'ap-northeast-1'
process.env.SQS_QUEUE_URL = 'https://sqs.test/queue'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// 005: focused unit tests for the regenerate path. Two boundaries are
// independently testable here:
//   1. zod input schema (FR-010: max 1000 char instruction)
//   2. enqueueDraftJob SQS service contract (DelaySeconds=0, trim, omit empty)
// The full regenerateDraftFn handler (auth middleware + withTenant + SQS call +
// error result codes) is exercised end-to-end by the Playwright spec
// `app/tests/e2e/regenerate.spec.ts` (T021).

// --- 1. Schema parity test ---
// Mirror the schema from regenerate-draft.fn.ts. Any future drift between this
// snapshot and the actual fn must be caught by the type system + integration.
const inputSchema = z.object({
  conversationId: z.string().uuid(),
  instruction: z.string().max(1000).optional(),
})

const VALID_UUID = '11111111-1111-4111-9111-111111111111'

describe('regenerate-draft input validation (FR-010)', () => {
  it('rejects instruction longer than 1000 characters', () => {
    const result = inputSchema.safeParse({
      conversationId: VALID_UUID,
      instruction: 'a'.repeat(1001),
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths.some((p) => p.includes('instruction'))).toBe(true)
    }
  })

  it('accepts instruction exactly 1000 characters', () => {
    const result = inputSchema.safeParse({
      conversationId: VALID_UUID,
      instruction: 'a'.repeat(1000),
    })
    expect(result.success).toBe(true)
  })

  it('accepts omitted instruction (US2: bare regenerate)', () => {
    const result = inputSchema.safeParse({ conversationId: VALID_UUID })
    expect(result.success).toBe(true)
  })

  it('rejects invalid UUID conversationId', () => {
    const result = inputSchema.safeParse({ conversationId: 'not-a-uuid' })
    expect(result.success).toBe(false)
  })
})

// --- 2. SQS service contract test ---
// Mocks ONLY the AWS SDK so the real enqueueDraftJob runs.
const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn<(cmd: unknown) => Promise<void>>(),
}))

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = mockSend
  },
  SendMessageCommand: class {
    input: unknown
    constructor(input: unknown) {
      this.input = input
    }
  },
}))

const { enqueueDraftJob } = await import('~/server/services/sqs')

beforeEach(() => {
  vi.clearAllMocks()
  mockSend.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('enqueueDraftJob SQS contract (005)', () => {
  it('sends a SendMessageCommand with DelaySeconds=0', async () => {
    await enqueueDraftJob({
      conversationId: VALID_UUID,
      triggerType: 'regenerate',
    })
    expect(mockSend).toHaveBeenCalledOnce()
    const cmd = mockSend.mock.calls[0][0] as { input: { DelaySeconds: number; QueueUrl: string } }
    expect(cmd.input.DelaySeconds).toBe(0)
    expect(cmd.input.QueueUrl).toBe('https://sqs.test/queue')
  })

  it('omits the instruction key when undefined', async () => {
    await enqueueDraftJob({
      conversationId: VALID_UUID,
      triggerType: 'regenerate',
    })
    const cmd = mockSend.mock.calls[0][0] as { input: { MessageBody: string } }
    const body = JSON.parse(cmd.input.MessageBody)
    expect(body).toEqual({
      jobType: 'draft',
      conversationId: VALID_UUID,
      triggerType: 'regenerate',
    })
    expect(body).not.toHaveProperty('instruction')
  })

  it('omits the instruction key when whitespace-only', async () => {
    await enqueueDraftJob({
      conversationId: VALID_UUID,
      triggerType: 'regenerate',
      instruction: '   \n\t  ',
    })
    const cmd = mockSend.mock.calls[0][0] as { input: { MessageBody: string } }
    const body = JSON.parse(cmd.input.MessageBody)
    expect(body).not.toHaveProperty('instruction')
  })

  it('includes the trimmed instruction when non-empty', async () => {
    await enqueueDraftJob({
      conversationId: VALID_UUID,
      triggerType: 'regenerate',
      instruction: '  use ¥800  ',
    })
    const cmd = mockSend.mock.calls[0][0] as { input: { MessageBody: string } }
    const body = JSON.parse(cmd.input.MessageBody)
    expect(body.instruction).toBe('use ¥800')
  })

  it('propagates SQS errors so the caller can map to enqueue_failed', async () => {
    mockSend.mockRejectedValueOnce(new Error('SQS down'))
    await expect(
      enqueueDraftJob({
        conversationId: VALID_UUID,
        triggerType: 'regenerate',
      }),
    ).rejects.toThrow('SQS down')
  })
})
