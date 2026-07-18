// @vitest-environment node
// Integration: updateConversationSettings — partial updates, validation, RLS cross-tenant guard
// 009: getConversation の attachments マッピング (presigned URL / 取得不可 / レガシー行) と
// クロステナント時に presign が呼ばれないことの検証を追加

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { isNotFound } from '@tanstack/react-router'
import type { TenantTx } from '~/server/db/with-tenant'
import type { ConversationDetail } from '~/routes/(app)/threads/$id/-lib/get-conversation.fn'

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CONV_ID   = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const { mockGetAttachmentUrl } = vi.hoisted(() => ({
  mockGetAttachmentUrl: vi.fn(),
}))

beforeAll(() => {
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost:5432/test')
  vi.stubEnv('DATABASE_URL_SERVICE_ROLE', 'postgresql://test:test@localhost:5432/test')
  vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
  vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'test-key')
  vi.stubEnv('SUPABASE_SECRET_KEY', 'test-secret')
  vi.stubEnv('AWS_REGION', 'ap-northeast-1')
})
afterAll(() => {
  vi.unstubAllEnvs()
})

vi.mock('~/server/db/client', () => ({ db: {}, dbAdmin: {} }))

// 009: presigner はローカル署名のみだが、テストでは URL 生成の呼び出し境界を検証する
vi.mock('~/server/services/media-url', () => ({
  getAttachmentUrl: mockGetAttachmentUrl,
}))

import {
  handleUpdateConversationSettings,
  updateConversationSettingsSchema,
} from '~/routes/(app)/threads/$id/-lib/update-conversation-settings.server'
import { handleGetConversation } from '~/routes/(app)/threads/$id/-lib/get-conversation.fn'

function makeTx(opts: { rows?: unknown[]; onSet?: (v: Record<string, unknown>) => void }) {
  const { rows = [{ id: CONV_ID }], onSet } = opts
  return {
    update: vi.fn().mockReturnThis(),
    set: vi.fn((v: Record<string, unknown>) => {
      if (onSet) onSet(v)
      return {
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue(rows),
      }
    }),
  } as unknown as TenantTx
}

describe('ConversationDetail — summary fields (T051)', () => {
  it('type includes summary and last_summarized_at on conversation', () => {
    // Type-level assertion: ConversationDetail.conversation must expose summary fields
    const detail = {
      conversation: {
        id: CONV_ID,
        customer_psid: 'psid',
        customer_name: null,
        last_inbound_at: null,
        within_24h_window: false,
        hours_remaining_in_window: null,
        summary: 'Customer asked about Charizard.',
        last_summarized_at: '2026-05-20T00:00:00.000Z',
        tone_preset: null,
        custom_prompt: null,
        note: null,
      },
      messages: [],
      latest_draft: null,
    } satisfies ConversationDetail

    expect(detail.conversation.summary).toBe('Customer asked about Charizard.')
    expect(detail.conversation.last_summarized_at).toBe('2026-05-20T00:00:00.000Z')
  })

  it('returns null summary when no summary has been generated yet', () => {
    const detail = {
      conversation: {
        id: CONV_ID,
        customer_psid: 'psid',
        customer_name: null,
        last_inbound_at: null,
        within_24h_window: false,
        hours_remaining_in_window: null,
        summary: null,
        last_summarized_at: null,
        tone_preset: null,
        custom_prompt: null,
        note: null,
      },
      messages: [],
      latest_draft: null,
    } satisfies ConversationDetail

    expect(detail.conversation.summary).toBeNull()
    expect(detail.conversation.last_summarized_at).toBeNull()
  })
})

describe('updateConversationSettingsSchema', () => {
  it('rejects when no optional fields provided', () => {
    const result = updateConversationSettingsSchema.safeParse({ conversationId: CONV_ID })
    expect(result.success).toBe(false)
  })

  it('rejects customPrompt > 1000 chars', () => {
    const result = updateConversationSettingsSchema.safeParse({
      conversationId: CONV_ID,
      customPrompt: 'x'.repeat(1001),
    })
    expect(result.success).toBe(false)
  })

  it('rejects note > 1000 chars', () => {
    const result = updateConversationSettingsSchema.safeParse({
      conversationId: CONV_ID,
      note: 'x'.repeat(1001),
    })
    expect(result.success).toBe(false)
  })

  it('accepts tonePreset null', () => {
    const result = updateConversationSettingsSchema.safeParse({
      conversationId: CONV_ID,
      tonePreset: null,
    })
    expect(result.success).toBe(true)
  })
})

describe('handleUpdateConversationSettings', () => {
  it('partial update — tonePreset only, does not touch other columns', async () => {
    let capturedSet: Record<string, unknown> | undefined
    const tx = makeTx({ onSet: (v) => { capturedSet = v } })

    const result = await handleUpdateConversationSettings(tx, TENANT_ID, {
      conversationId: CONV_ID,
      tonePreset: 'concise',
    })

    expect(result).toMatchObject({ ok: true })
    expect(capturedSet).toEqual({ tonePreset: 'concise' })
    expect(capturedSet?.customPrompt).toBeUndefined()
    expect(capturedSet?.note).toBeUndefined()
  })

  it('empty string → NULL normalization for customPrompt and note', async () => {
    let capturedSet: Record<string, unknown> | undefined
    const tx = makeTx({ onSet: (v) => { capturedSet = v } })

    await handleUpdateConversationSettings(tx, TENANT_ID, {
      conversationId: CONV_ID,
      customPrompt: '',
      note: '',
    })

    expect(capturedSet?.customPrompt).toBeNull()
    expect(capturedSet?.note).toBeNull()
  })

  it('cross-tenant / not found → returns CONVERSATION_NOT_FOUND', async () => {
    const tx = makeTx({ rows: [] })

    const result = await handleUpdateConversationSettings(tx, TENANT_ID, {
      conversationId: CONV_ID,
      tonePreset: 'friendly',
    })

    expect(result).toMatchObject({ ok: false, code: 'CONVERSATION_NOT_FOUND' })
  })

  it('tonePreset null resets tone (passes null to SET)', async () => {
    let capturedSet: Record<string, unknown> | undefined
    const tx = makeTx({ onSet: (v) => { capturedSet = v } })

    await handleUpdateConversationSettings(tx, TENANT_ID, {
      conversationId: CONV_ID,
      tonePreset: null,
    })

    expect(capturedSet?.tonePreset).toBeNull()
  })

  it('all three fields together — all appear in SET', async () => {
    let capturedSet: Record<string, unknown> | undefined
    const tx = makeTx({ onSet: (v) => { capturedSet = v } })

    await handleUpdateConversationSettings(tx, TENANT_ID, {
      conversationId: CONV_ID,
      tonePreset: 'professional',
      customPrompt: 'Be formal.',
      note: 'VIP customer.',
    })

    expect(capturedSet).toEqual({
      tonePreset: 'professional',
      customPrompt: 'Be formal.',
      note: 'VIP customer.',
    })
  })
})

// --- 009: getConversation attachments マッピング ---

// handleGetConversation が発行するクエリ列に順番どおり結果を返す fake tx。
// 1) conversations select (.limit(1)) 2) unreadCount update 3) messages select
// (.orderBy() を await) 4) aiDrafts select (.limit(1))
function makeGetConversationTx(selectResults: unknown[][]) {
  let i = 0
  const makeChain = () => {
    const result = selectResults[i++] ?? []
    const chain: Record<string, unknown> = {}
    Object.assign(chain, {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async () => result,
      then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(onFulfilled, onRejected),
    })
    return chain
  }
  return {
    select: () => makeChain(),
    update: () => ({ set: () => ({ where: async () => [] }) }),
  } as unknown as TenantTx
}

const CONV_ROW = {
  id: CONV_ID,
  customerPsid: 'psid-1',
  customerName: 'Alice',
  lastInboundAt: null,
  summary: null,
  lastSummarizedAt: null,
  tonePreset: null,
  customPrompt: null,
  note: null,
}

function makeMsgRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm',
    direction: 'inbound',
    body: '',
    messageType: 'image',
    timestamp: new Date('2026-07-18T00:00:00Z'),
    sendStatus: null,
    sendError: null,
    attachments: null,
    ...overrides,
  }
}

describe('handleGetConversation — attachments (009 T018/T027)', () => {
  beforeEach(() => {
    mockGetAttachmentUrl.mockReset()
    mockGetAttachmentUrl.mockImplementation(async (key: string) => `https://signed.example/${key}`)
  })

  it('maps stored attachment to presigned url and unavailable one to url: null, without leaking s3Key', async () => {
    const tx = makeGetConversationTx([
      [CONV_ROW],
      [
        makeMsgRow({
          attachments: [
            { index: 0, type: 'image', s3Key: `${TENANT_ID}/${CONV_ID}/m_1/0`, contentType: 'image/jpeg', sizeBytes: 123 },
            { index: 1, type: 'video', s3Key: null },
          ],
        }),
      ],
      [],
    ])

    const result = await handleGetConversation(tx, CONV_ID)

    const atts = result.messages[0]!.attachments
    expect(atts).toEqual([
      { index: 0, type: 'image', url: `https://signed.example/${TENANT_ID}/${CONV_ID}/m_1/0` },
      { index: 1, type: 'video', url: null },
    ])
    // s3Key は内部キーのためクライアントに露出させない (contracts §4)
    for (const att of atts) {
      expect(Object.keys(att).sort()).toEqual(['index', 'type', 'url'])
    }
    expect(mockGetAttachmentUrl).toHaveBeenCalledTimes(1)
  })

  it('returns [] for legacy rows (attachments NULL) and keeps message_type-driven rendering possible', async () => {
    const tx = makeGetConversationTx([
      [CONV_ROW],
      [makeMsgRow({ attachments: null, messageType: 'image', body: '' })],
      [],
    ])

    const result = await handleGetConversation(tx, CONV_ID)

    expect(result.messages[0]!.attachments).toEqual([])
    expect(result.messages[0]!.message_type).toBe('image')
    expect(mockGetAttachmentUrl).not.toHaveBeenCalled()
  })

  it("normalizes out-of-union message_type (e.g. legacy 'other') to 'unknown'", async () => {
    const tx = makeGetConversationTx([
      [CONV_ROW],
      [makeMsgRow({ messageType: 'other' })],
      [],
    ])

    const result = await handleGetConversation(tx, CONV_ID)
    expect(result.messages[0]!.message_type).toBe('unknown')
  })

  it('cross-tenant / unknown conversation id → notFound thrown and presign never called (FR-010 / SC-006)', async () => {
    // RLS 下では他テナントの会話は SELECT に現れない = 空配列
    const tx = makeGetConversationTx([[]])

    await expect(handleGetConversation(tx, CONV_ID)).rejects.toSatisfy((err) => isNotFound(err))
    expect(mockGetAttachmentUrl).not.toHaveBeenCalled()
  })
})
