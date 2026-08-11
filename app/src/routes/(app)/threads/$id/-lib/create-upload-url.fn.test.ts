// env proxy は初回アクセスで全必須変数を検証する
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
process.env.MEDIA_BUCKET_NAME = 'test-media-bucket'

import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TenantTx } from '~/server/db/with-tenant'
import { ALLOWED_IMAGE_TYPES, MAX_ATTACHMENT_BYTES, isValidOutboundKey } from '~/server/services/media-upload'

vi.mock('~/server/db/client', () => ({ db: {}, dbAdmin: {} }))

const NOW = new Date('2026-05-01T00:00:00Z').getTime()
const WITHIN = new Date('2026-04-30T12:00:00Z') // 12h ago
const OUTSIDE = new Date('2026-04-29T00:00:00Z') // 48h ago
const CONVERSATION_ID = '00000000-0000-0000-0000-000000000001'
const TENANT_ID = '00000000-0000-0000-0000-000000000004'

function buildMockTx(opts: { lastInboundAt?: Date | null; conversationExists?: boolean }): TenantTx {
  const { lastInboundAt = WITHIN, conversationExists = true } = opts
  const convRows = conversationExists ? [{ id: CONVERSATION_ID, lastInboundAt }] : []
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(convRows),
  } as unknown as TenantTx
}

const baseData = { conversationId: CONVERSATION_ID, contentType: 'image/jpeg', sizeBytes: 1000 }

// スキーマ検証は resetModules に影響されないよう先に定義 (先に実行される)
describe('createUploadUrlFn input schema', () => {
  const schema = z.object({
    conversationId: z.string().uuid(),
    contentType: z.enum(ALLOWED_IMAGE_TYPES),
    sizeBytes: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
  })
  it('allowlist 外 contentType を弾く', () => {
    expect(schema.safeParse({ conversationId: CONVERSATION_ID, contentType: 'application/pdf', sizeBytes: 100 }).success).toBe(false)
  })
  it('sizeBytes 0 / 超過を弾く', () => {
    expect(schema.safeParse({ conversationId: CONVERSATION_ID, contentType: 'image/jpeg', sizeBytes: 0 }).success).toBe(false)
    expect(schema.safeParse({ conversationId: CONVERSATION_ID, contentType: 'image/jpeg', sizeBytes: MAX_ATTACHMENT_BYTES + 1 }).success).toBe(false)
  })
  it('正常な contentType/sizeBytes を通す', () => {
    // zod .uuid() は version nibble を検証するため v4 形式を使う
    expect(schema.safeParse({ conversationId: '11111111-1111-4111-8111-111111111111', contentType: 'image/webp', sizeBytes: 1000 }).success).toBe(true)
  })
})

describe('handleCreateUploadUrl', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(NOW))
  afterEach(() => vi.restoreAllMocks())

  it('正常系: サーバー採番キー + presigned URL を返す', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { handleCreateUploadUrl } = await import('./create-upload-url.server')
    const res = await handleCreateUploadUrl(buildMockTx({}), TENANT_ID, baseData)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(isValidOutboundKey(res.s3Key, TENANT_ID, CONVERSATION_ID)).toBe(true)
      expect(res.uploadUrl).toContain(`/${res.s3Key}?`)
      expect(res.uploadUrl).toContain('X-Amz-Signature')
    }
    const log = infoSpy.mock.calls.find((c) => (c[0] as { event?: string })?.event === 'outbound_upload_url_issued')
    expect(log).toBeDefined()
  })

  it('会話が別テナント/存在しない → not_found', async () => {
    const { handleCreateUploadUrl } = await import('./create-upload-url.server')
    const res = await handleCreateUploadUrl(buildMockTx({ conversationExists: false }), TENANT_ID, baseData)
    expect(res).toEqual({ ok: false, error: 'not_found' })
  })

  it('ウィンドウ外 → outside_window', async () => {
    const { handleCreateUploadUrl } = await import('./create-upload-url.server')
    const res = await handleCreateUploadUrl(buildMockTx({ lastInboundAt: OUTSIDE }), TENANT_ID, baseData)
    expect(res).toEqual({ ok: false, error: 'outside_window' })
  })

  // T022: フォームを開いたまま期限切れ (ウィンドウ ドリフト) → アップロード URL 発行も弾く
  it('T022: フォーム保持中に期限切れ → outside_window でアップロードさせない', async () => {
    const { handleCreateUploadUrl } = await import('./create-upload-url.server')
    const res = await handleCreateUploadUrl(buildMockTx({ lastInboundAt: OUTSIDE }), TENANT_ID, baseData)
    expect(res).toEqual({ ok: false, error: 'outside_window' })
  })

  it('lastInboundAt が null → outside_window', async () => {
    const { handleCreateUploadUrl } = await import('./create-upload-url.server')
    const res = await handleCreateUploadUrl(buildMockTx({ lastInboundAt: null }), TENANT_ID, baseData)
    expect(res).toEqual({ ok: false, error: 'outside_window' })
  })

  // resetModules を伴うため最後に置く (以降にテストを足さない)
  it('MEDIA_BUCKET_NAME 未設定 → not_configured', async () => {
    vi.resetModules()
    process.env.MEDIA_BUCKET_NAME = ''
    const { handleCreateUploadUrl } = await import('./create-upload-url.server')
    const res = await handleCreateUploadUrl(buildMockTx({}), TENANT_ID, baseData)
    expect(res).toEqual({ ok: false, error: 'not_configured' })
    process.env.MEDIA_BUCKET_NAME = 'test-media-bucket'
  })
})
