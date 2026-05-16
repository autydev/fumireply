// @vitest-environment node
// Integration (T039): cross-tenant safety. Tenant A tries to connect a pageId
// already owned by tenant B. Under withTenant RLS, A cannot see B's row, so the
// handler takes the INSERT path; the global page_id unique constraint then fires
// (pg 23505) and is surfaced as already_connected WITHOUT overwriting B's row
// (no UPDATE is ever issued against another tenant's row).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setupServer } from 'msw/node'
import { fetchPageSuccess, subscribeSuccess } from '~/test/msw/facebook-handlers'
import type { TenantTx } from '~/server/db/with-tenant'

vi.mock('~/server/services/crypto', () => ({
  getMasterKey: vi.fn().mockResolvedValue(Buffer.alloc(32)),
  decryptToken: vi.fn().mockReturnValue('LONG_USER_TOKEN_DECRYPTED'),
  encryptToken: vi.fn().mockReturnValue(Buffer.from('ENCRYPTED_PAGE_TOKEN')),
}))

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PAGE_OWNED_BY_B = '9998887776'
const SESSION = Buffer.from('encrypted-long-token').toString('base64')

const server = setupServer()
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
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  server.resetHandlers()
  vi.clearAllMocks()
})
afterAll(() => {
  server.close()
  vi.unstubAllEnvs()
})

import { handleConnectPage } from '~/routes/(app)/onboarding/connect-page/-lib/connect-page.server'

describe('connectPageFn cross-tenant safety (T039)', () => {
  it('tenant A connecting tenant B\'s pageId → 23505 → already_connected, no UPDATE on B row', async () => {
    server.use(fetchPageSuccess(PAGE_OWNED_BY_B), subscribeSuccess(PAGE_OWNED_BY_B))

    const insertSpy = vi.fn()
    const updateSpy = vi.fn()
    let selectCall = 0

    // RLS: tenant A sees no active rows (select#1 = []) and cannot see B's row
    // for this pageId (select#2 = []), so the handler attempts a plain INSERT.
    const makeSelectChain = () => {
      ++selectCall
      const chain: Record<string, unknown> = {}
      chain.from = vi.fn().mockReturnValue(chain)
      chain.where = vi.fn().mockReturnValue(chain)
      chain.limit = vi.fn().mockResolvedValue([]) // RLS hides B's row from A
      return chain
    }
    const insertChain = {
      values: vi.fn().mockImplementation(() => {
        insertSpy()
        // global page_id unique constraint violation
        return Promise.reject(Object.assign(new Error('duplicate key'), { code: '23505' }))
      }),
    }
    const updateChain = {
      set: vi.fn().mockReturnValue({ where: vi.fn().mockImplementation(() => { updateSpy(); return Promise.resolve() }) }),
    }
    const tx = {
      select: vi.fn().mockImplementation(makeSelectChain),
      insert: vi.fn().mockReturnValue(insertChain),
      update: vi.fn().mockReturnValue(updateChain),
    } as unknown as TenantTx

    const clearSession = vi.fn()
    const result = await handleConnectPage(tx, TENANT_A, { pageId: PAGE_OWNED_BY_B }, {
      encodedSession: SESSION,
      clearSession,
    })

    expect(result).toEqual({
      ok: false,
      error: 'already_connected',
      message: expect.any(String),
    })
    // B's row is never updated by A; only a failed INSERT was attempted
    expect(insertSpy).toHaveBeenCalledOnce()
    expect(updateSpy).not.toHaveBeenCalled()
    // session is NOT cleared on failure (user can retry)
    expect(clearSession).not.toHaveBeenCalled()
    expect(selectCall).toBe(2)
  })
})
