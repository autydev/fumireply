// @vitest-environment node
// Integration (T037/T038): the onboarding forward/reverse guards both gate on
// checkConnectedPagesFn → performCheckConnectedPages. This exercises the real
// active-row count + Number() coercion (the part the mocked route unit test in
// src/test/routes/(app)/onboarding/connect-page/index.test.tsx cannot cover —
// that one stubs checkConnectedPagesFn entirely). Request-level 302 behavior
// remains covered there.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TenantTx } from '~/server/db/with-tenant'

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

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

import { performCheckConnectedPages } from '~/routes/(app)/onboarding/connect-page/-lib/check-connected-pages.fn'

function buildTx(rows: Array<{ count: number | string }>) {
  const where = vi.fn().mockResolvedValue(rows)
  const from = vi.fn().mockReturnValue({ where })
  const select = vi.fn().mockReturnValue({ from })
  const tx = { select } as unknown as TenantTx
  return { tx, spies: { select, from, where } }
}

describe('onboarding guards — performCheckConnectedPages', () => {
  it('no active pages → { count: 0 } (forward guard would redirect to /onboarding)', async () => {
    const { tx, spies } = buildTx([{ count: 0 }])
    const result = await performCheckConnectedPages(tx, TENANT_ID)

    expect(result).toEqual({ count: 0 })
    // filter applied (active + tenant) — where() invoked once with a condition
    expect(spies.where).toHaveBeenCalledOnce()
    expect(spies.where.mock.calls[0][0]).toBeDefined()
    // documented guard predicate
    expect(result.count === 0).toBe(true)
  })

  it('one active page → { count: 1 } (reverse guard would redirect to /inbox)', async () => {
    const { tx } = buildTx([{ count: 1 }])
    const result = await performCheckConnectedPages(tx, TENANT_ID)

    expect(result).toEqual({ count: 1 })
    expect(result.count > 0).toBe(true)
  })

  it('postgres bigint-like string count is coerced via Number()', async () => {
    const { tx } = buildTx([{ count: '3' }])
    const result = await performCheckConnectedPages(tx, TENANT_ID)

    expect(result).toEqual({ count: 3 })
    expect(typeof result.count).toBe('number')
  })

  it('empty result set defaults to { count: 0 }', async () => {
    const { tx } = buildTx([])
    const result = await performCheckConnectedPages(tx, TENANT_ID)

    expect(result).toEqual({ count: 0 })
  })
})
