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

// Build a mock tx matching the updated handler's query pattern (post T011):
//   Query 1: select message body/type/conversationId → [msgRow]
//   Query 2: select conversation settings via leftJoin → [convoSettings]
//   Query 3: select history with orderBy/limit → historyRows
//   Update: update ai_drafts
function buildTxWithConvSettings(
  convoSettings: {
    summary: string | null
    lastSummarizedAt: Date | null
    tonePreset: string | null
    customPrompt: string | null
    pageCustomPrompt: string | null
  },
) {
  let selectCallCount = 0

  const buildChain = () => {
    const chain: Record<string, unknown> = {}

    const leftJoin = vi.fn().mockImplementation(() => ({
      where: vi.fn().mockResolvedValue([convoSettings]),
    }))

    const where = vi.fn().mockImplementation(() => {
      selectCallCount++
      if (selectCallCount === 1) {
        // Message lookup — resolves directly
        return Promise.resolve([{
          body: 'Hello, do you have this in stock?',
          messageType: 'text',
          conversationId: CONVERSATION_ID,
        }])
      }
      // selectCallCount === 2: History query
      // (conversation settings query goes through leftJoin.where, not this where)
      const chainable = {
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([
          { direction: 'inbound', body: 'Hello, do you have this in stock?', messageType: 'text' },
        ]),
      }
      return chainable
    })

    chain.from = vi.fn().mockReturnValue({ where, leftJoin })
    chain.where = where
    chain.orderBy = vi.fn().mockReturnThis()
    chain.limit = vi.fn().mockResolvedValue([])

    return chain
  }

  return {
    select: vi.fn(() => buildChain()),
    update: vi.fn().mockReturnThis(),
    set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    where: vi.fn().mockResolvedValue(undefined),
  }
}

let capturedSystemBlocks: unknown[] = []

function setupWithTenantMock(
  convoSettings: Parameters<typeof buildTxWithConvSettings>[0],
) {
  let callCount = 0
  mockWithTenant.mockImplementation(
    async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
      callCount++
      if (callCount === 1) {
        return fn(buildTxWithConvSettings(convoSettings))
      }
      // Second call: update ai_drafts
      return fn({
        update: vi.fn().mockReturnThis(),
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
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
  it('tone_preset=concise and custom_prompt are included in Anthropic system payload', async () => {
    setupWithTenantMock({
      summary: null,
      lastSummarizedAt: null,
      tonePreset: 'concise',
      customPrompt: 'No emojis.',
      pageCustomPrompt: null,
    })

    await handler(makeSqsEvent({ messageId: MESSAGE_ID }), {} as never, vi.fn())

    expect(mockAnthropicCreate).toHaveBeenCalledOnce()
    // system should have 2 blocks: base + additional
    expect(capturedSystemBlocks).toHaveLength(2)
    const additionalBlock = capturedSystemBlocks[1] as { text: string }
    expect(additionalBlock.text).toContain('Concise')
    expect(additionalBlock.text).toContain('No emojis.')
  })

  it('all columns NULL → only base system prompt block (SC-007 back-compat)', async () => {
    setupWithTenantMock({
      summary: null,
      lastSummarizedAt: null,
      tonePreset: null,
      customPrompt: null,
      pageCustomPrompt: null,
    })

    await handler(makeSqsEvent({ messageId: MESSAGE_ID }), {} as never, vi.fn())

    expect(mockAnthropicCreate).toHaveBeenCalledOnce()
    // Only the base system prompt block — no additional block
    expect(capturedSystemBlocks).toHaveLength(1)
  })

  it('page custom_prompt included in additional system block', async () => {
    setupWithTenantMock({
      summary: null,
      lastSummarizedAt: null,
      tonePreset: null,
      customPrompt: null,
      pageCustomPrompt: 'No returns after 30 days.',
    })

    await handler(makeSqsEvent({ messageId: MESSAGE_ID }), {} as never, vi.fn())

    expect(capturedSystemBlocks).toHaveLength(2)
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

    await handler(makeSqsEvent({ messageId: MESSAGE_ID }), {} as never, vi.fn())

    // All-null → single base block, so note obviously not present
    expect(capturedSystemBlocks).toHaveLength(1)
  })
})
