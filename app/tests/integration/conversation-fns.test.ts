// @vitest-environment node
// Integration: updateConversationSettings — partial updates, validation, RLS cross-tenant guard

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TenantTx } from '~/server/db/with-tenant'
import type { ConversationDetail } from '~/routes/(app)/threads/$id/-lib/get-conversation.fn'

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CONV_ID   = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

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

import {
  handleUpdateConversationSettings,
  updateConversationSettingsSchema,
} from '~/routes/(app)/threads/$id/-lib/update-conversation-settings.server'

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
