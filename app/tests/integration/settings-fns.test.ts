// @vitest-environment node
// Integration (T020): handleListSettings + handleUpdatePagePrompt
// Tests: happy path, 2001-char rejection, cross-tenant write (RLS → 404), empty string normalization to NULL

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TenantTx } from '~/server/db/with-tenant'

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PAGE_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

vi.mock('~/server/db/client', () => ({ db: {}, dbAdmin: {} }))
vi.mock('~/server/db/with-tenant', () => ({
  withTenant: vi.fn(),
}))

import { withTenant } from '~/server/db/with-tenant'
const mockWithTenant = vi.mocked(withTenant)

beforeAll(() => {
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost:5432/test')
  vi.stubEnv('DATABASE_URL_SERVICE_ROLE', 'postgresql://test:test@localhost:5432/test')
  vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
  vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'test-key')
  vi.stubEnv('SUPABASE_SECRET_KEY', 'test-secret')
  vi.stubEnv('META_APP_ID', '1234567890')
  vi.stubEnv('META_APP_SECRET_SSM_KEY', '/test/meta/secret')
  vi.stubEnv('WEBHOOK_VERIFY_TOKEN_SSM_KEY', '/test/webhook/token')
  vi.stubEnv('ANTHROPIC_API_KEY_SSM_KEY', '/test/anthropic/key')
  vi.stubEnv('AWS_REGION', 'ap-northeast-1')
})
afterEach(() => vi.clearAllMocks())
afterAll(() => vi.unstubAllEnvs())

// ── handleListSettings ────────────────────────────────────────────────────────

import { handleListSettings } from '~/routes/(app)/settings/-lib/list-settings.server'

function buildListTx(rows: Array<{
  id: string; pageId: string; pageName: string; isActive: boolean
  connectedAt: Date; customPrompt: string | null
}>) {
  return {
    select: () => ({ from: () => ({ orderBy: () => Promise.resolve(rows) }) }),
  } as unknown as TenantTx
}

describe('handleListSettings', () => {
  it('happy path: maps rows and returns ISO connectedAt strings', async () => {
    const now = new Date()
    const earlier = new Date(now.getTime() - 10_000)
    mockWithTenant.mockImplementationOnce((_tid, fn) =>
      fn(buildListTx([
        { id: PAGE_UUID, pageId: '111', pageName: 'Page A', isActive: true, connectedAt: now, customPrompt: 'Hello' },
        { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', pageId: '222', pageName: 'Page B', isActive: false, connectedAt: earlier, customPrompt: null },
      ])),
    )
    const result = await handleListSettings(TENANT_ID)
    expect(result.connectedPages).toHaveLength(2)
    expect(result.connectedPages[0].customPrompt).toBe('Hello')
    expect(result.connectedPages[1].customPrompt).toBeNull()
    expect(typeof result.connectedPages[0].connectedAt).toBe('string')
  })

  it('returns empty array when no pages', async () => {
    mockWithTenant.mockImplementationOnce((_tid, fn) => fn(buildListTx([])))
    const result = await handleListSettings(TENANT_ID)
    expect(result.connectedPages).toEqual([])
  })
})

// ── handleUpdatePagePrompt ────────────────────────────────────────────────────

import { handleUpdatePagePrompt } from '~/routes/(app)/settings/-lib/update-page-prompt.server'

function buildUpdateTx(affected: Array<{ id: string }>) {
  return {
    update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve(affected) }) }) }),
  } as unknown as TenantTx
}

describe('handleUpdatePagePrompt', () => {
  it('happy path: returns ok=true and ISO updatedAt', async () => {
    mockWithTenant.mockImplementationOnce((_tid, fn) => fn(buildUpdateTx([{ id: PAGE_UUID }])))
    const result = await handleUpdatePagePrompt(TENANT_ID, PAGE_UUID, 'Shop policy')
    expect(result.ok).toBe(true)
    expect(() => new Date(result.updatedAt)).not.toThrow()
  })

  it('empty string normalizes to NULL (whitespace-only also)', async () => {
    for (const input of ['', '   ']) {
      let capturedSet: { customPrompt: unknown } | undefined
      const tx = {
        update: () => ({
          set: (v: { customPrompt: unknown }) => { capturedSet = v; return { where: () => ({ returning: () => Promise.resolve([{ id: PAGE_UUID }]) }) } },
        }),
      } as unknown as TenantTx
      mockWithTenant.mockImplementationOnce((_tid, fn) => fn(tx))
      await handleUpdatePagePrompt(TENANT_ID, PAGE_UUID, input)
      expect(capturedSet?.customPrompt).toBeNull()
    }
  })

  it('cross-tenant RLS: 0 affected rows → throws code=PAGE_NOT_FOUND', async () => {
    mockWithTenant.mockImplementationOnce((_tid, fn) => fn(buildUpdateTx([])))
    await expect(
      handleUpdatePagePrompt('dddddddd-dddd-4ddd-8ddd-dddddddddddd', PAGE_UUID, 'text'),
    ).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' })
  })
})

// ── Zod validator (unit) ──────────────────────────────────────────────────────
// Use the production inputSchema directly so tests stay in sync with the server fn

import { updatePagePromptInputSchema } from '~/routes/(app)/settings/-lib/update-page-prompt.fn'

describe('updatePagePromptFn input schema', () => {
  it('rejects (PAGE_PROMPT_MAX + 1)-char prompt with PAGE_PROMPT_TOO_LONG', () => {
    const parsed = updatePagePromptInputSchema.safeParse({ connectedPageId: PAGE_UUID, customPrompt: 'a'.repeat(2001) })
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues[0].message).toBe('PAGE_PROMPT_TOO_LONG')
  })

  it('accepts exactly PAGE_PROMPT_MAX chars', () => {
    expect(updatePagePromptInputSchema.safeParse({ connectedPageId: PAGE_UUID, customPrompt: 'a'.repeat(2000) }).success).toBe(true)
  })
})
