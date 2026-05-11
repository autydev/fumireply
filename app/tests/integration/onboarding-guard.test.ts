// @vitest-environment node
// Integration: forward + reverse onboarding guards via countActiveConnectedPages
// Verifies the guard primitive that powers:
//   - forward guard: empty connected_pages → redirect to /onboarding/connect-page
//   - reverse guard: existing row → redirect back to /inbox

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/db/client', () => ({ db: {}, dbAdmin: {} }))

import { countActiveConnectedPages } from '~/server/services/check-connected-pages.fn'
import type { TenantTx } from '~/server/db/with-tenant'

beforeAll(() => {
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost:5432/test')
})
afterEach(() => vi.clearAllMocks())
afterAll(() => vi.unstubAllEnvs())

function buildTx(rowCount: number): TenantTx {
  const chain: Record<string, unknown> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockResolvedValue([{ value: rowCount }])

  return {
    select: vi.fn().mockReturnValue(chain),
  } as unknown as TenantTx
}

describe('countActiveConnectedPages (powers both forward and reverse onboarding guards)', () => {
  it('forward guard: returns 0 when tenant has no connected pages → triggers redirect to /onboarding/connect-page', async () => {
    const tx = buildTx(0)
    expect(await countActiveConnectedPages(tx)).toBe(0)
  })

  it('reverse guard: returns 1 when tenant has a connected page → triggers redirect back to /inbox', async () => {
    const tx = buildTx(1)
    expect(await countActiveConnectedPages(tx)).toBe(1)
  })

  it('handles missing aggregate row defensively (returns 0)', async () => {
    const chain: Record<string, unknown> = {}
    chain.from = vi.fn().mockReturnValue(chain)
    chain.where = vi.fn().mockResolvedValue([]) // empty aggregate result
    const tx = { select: vi.fn().mockReturnValue(chain) } as unknown as TenantTx
    expect(await countActiveConnectedPages(tx)).toBe(0)
  })
})
