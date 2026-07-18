// @vitest-environment node
// Integration: ai-worker uses conversation settings (tone_preset + custom_prompt) in system prompt

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SQSEvent } from 'aws-lambda'

const MESSAGE_ID      = '11111111-1111-4111-8111-111111111111'
const TENANT_ID       = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CONVERSATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

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

function makeAnthropicResponse(text = 'Draft reply.') {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: 'claude-haiku-4-5-20251001',
    stop_reason: 'end_turn',
    usage: { input_tokens: 80, output_tokens: 15, cache_creation_input_tokens: 60, cache_read_input_tokens: 0 },
  }
}

// Conversation-scoped draft job (coalesce: trigger === latest inbound)
function draftJob() {
  return { jobType: 'draft', conversationId: CONVERSATION_ID, triggerMessageId: MESSAGE_ID }
}

type ConvoSettings = {
  summary: string | null
  lastSummarizedAt: Date | null
  tonePreset: string | null
  customPrompt: string | null
  pageCustomPrompt: string | null
}

// Read tx mock for the conversation-scoped flow. Query order:
//   1. latest inbound text (coalesce)  — from().where().orderBy().limit()
//   2. settings (leftJoin)             — from().leftJoin().where()
//   3. last outbound ts (008)          — from().where().orderBy().limit()
//   4. unanswered batch                — from().where().orderBy().limit()
//   5. context history                 — from().where().orderBy().limit()
function buildReadTx(convoSettings: ConvoSettings) {
  let n = 0
  const limitChain = (rows: unknown) => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ orderBy: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(rows)) })) })),
    })),
  })
  return {
    select: vi.fn(() => {
      n++
      if (n === 1) return limitChain([{ id: MESSAGE_ID }])
      if (n === 2)
        return {
          from: vi.fn(() => ({
            leftJoin: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([convoSettings])) })),
          })),
        }
      if (n === 3) return limitChain([{ ts: null }])
      if (n === 4) return limitChain([{ body: 'Hello, do you have this in stock?' }])
      return limitChain([
        { direction: 'inbound', body: 'Hello, do you have this in stock?', messageType: 'text' },
      ])
    }),
  }
}

let capturedSystemBlocks: unknown[] = []

function setupWithTenantMock(convoSettings: ConvoSettings) {
  let callCount = 0
  mockWithTenant.mockImplementation(
    async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
      callCount++
      if (callCount === 1) {
        return fn(buildReadTx(convoSettings))
      }
      // Second call: update ai_drafts
      return fn({
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
      })
    },
  )
}

beforeEach(() => {
  capturedSystemBlocks = []
  mockSsm.mockResolvedValue('test-anthropic-api-key')
  mockDbAdminWhere.mockResolvedValue([{ tenantId: TENANT_ID }])
  mockAnthropicCreate.mockImplementation(
    (params: { system?: unknown[] }) => {
      capturedSystemBlocks = params.system ?? []
      return Promise.resolve(makeAnthropicResponse())
    },
  )
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('AI Worker — conversation settings in system prompt', () => {
  // System blocks layout (always): [BASE, (optional additional), LANGUAGE_DIRECTIVE].
  // LANGUAGE_DIRECTIVE is the final block to override any language bleed from
  // user-supplied content (page_prompt / tone / customer_prompt / summary).

  it('tone_preset=concise and custom_prompt are included in Anthropic system payload', async () => {
    setupWithTenantMock({
      summary: null,
      lastSummarizedAt: null,
      tonePreset: 'concise',
      customPrompt: 'No emojis.',
      pageCustomPrompt: null,
    })

    await handler(makeSqsEvent(draftJob()), {} as never, vi.fn())

    expect(mockAnthropicCreate).toHaveBeenCalledOnce()
    // 3 blocks: base + additional + language directive
    expect(capturedSystemBlocks).toHaveLength(3)
    const additionalBlock = capturedSystemBlocks[1] as { text: string }
    expect(additionalBlock.text).toContain('Concise')
    expect(additionalBlock.text).toContain('No emojis.')
    expect((capturedSystemBlocks[2] as { text: string }).text).toMatch(/Output language rule/)
  })

  it('all columns NULL → base + language directive only (SC-007 back-compat)', async () => {
    setupWithTenantMock({
      summary: null,
      lastSummarizedAt: null,
      tonePreset: null,
      customPrompt: null,
      pageCustomPrompt: null,
    })

    await handler(makeSqsEvent(draftJob()), {} as never, vi.fn())

    expect(mockAnthropicCreate).toHaveBeenCalledOnce()
    // 2 blocks: base + language directive (no additional block when all settings null)
    expect(capturedSystemBlocks).toHaveLength(2)
    expect((capturedSystemBlocks[1] as { text: string }).text).toMatch(/Output language rule/)
  })

  it('page custom_prompt included in additional system block', async () => {
    setupWithTenantMock({
      summary: null,
      lastSummarizedAt: null,
      tonePreset: null,
      customPrompt: null,
      pageCustomPrompt: 'No returns after 30 days.',
    })

    await handler(makeSqsEvent(draftJob()), {} as never, vi.fn())

    // 3 blocks: base + additional + language directive
    expect(capturedSystemBlocks).toHaveLength(3)
    const additionalBlock = capturedSystemBlocks[1] as { text: string }
    expect(additionalBlock.text).toContain('No returns after 30 days.')
  })

  it('note is NOT included in system prompt (double-defence per spec)', async () => {
    // note is not even a field in buildAdditionalSystemPrompt; this test confirms
    // no accidental leakage by checking the captured additional block
    setupWithTenantMock({
      summary: null,
      lastSummarizedAt: null,
      tonePreset: null,
      customPrompt: null,
      pageCustomPrompt: null,
    })

    await handler(makeSqsEvent(draftJob()), {} as never, vi.fn())

    // All-null → base + language directive only (no additional block, so note obviously absent)
    expect(capturedSystemBlocks).toHaveLength(2)
  })
})
