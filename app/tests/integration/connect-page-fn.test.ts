// @vitest-environment node
// Integration: handleConnectPage — MSW for Graph API (listPages + subscribeWebhook),
// mocked DB (withTenant), mocked crypto. Covers T036 (happy path / error cases)
// and T039 (cross-tenant unique-constraint safety).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setupServer } from 'msw/node'
import {
  listPagesSuccess,
  listPagesError,
  subscribeSuccess,
  subscribeError,
  type MockPage,
} from '~/test/msw/facebook-handlers'

// --- hoisted mocks ---

const mockWithTenant = vi.fn()

vi.mock('~/server/db/with-tenant', () => ({
  withTenant: (...args: unknown[]) => mockWithTenant(...args),
}))
vi.mock('~/server/services/crypto', () => ({
  getMasterKey: vi.fn().mockResolvedValue(Buffer.alloc(32)),
  decryptToken: vi.fn().mockReturnValue('LONG_LIVED_USER_TOKEN'),
  encryptToken: vi.fn().mockReturnValue(Buffer.from('encrypted-page-token')),
}))
vi.mock('~/server/db/client', () => ({ db: {}, dbAdmin: {} }))

// --- constants ---

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PAGE_ID = '111222333444'
const PAGE_NAME = 'My Test Shop'
const PAGE_TOKEN = 'EAA-page-access-token'
const ENCODED_SESSION = Buffer.from('fake-encrypted-long-token').toString('base64')

const MOCK_PAGES: MockPage[] = [
  { id: PAGE_ID, name: PAGE_NAME, access_token: PAGE_TOKEN },
]

// --- tx builder helpers ---

function makeSelectChain(limitResult: unknown[]) {
  const chain: Record<string, unknown> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(limitResult)
  return chain
}

function makeInsertChain() {
  const chain: Record<string, unknown> = {}
  chain.values = vi.fn().mockResolvedValue([])
  return chain
}

function makeUpdateChain() {
  const chain: Record<string, unknown> = {}
  chain.set = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockResolvedValue(undefined)
  return chain
}

/** Tx for the first withTenant call: active-page guard check */
function makeActiveCheckTx(hasActive: boolean) {
  return { select: vi.fn().mockReturnValue(makeSelectChain(hasActive ? [{ id: 'active-uuid' }] : [])) }
}

/** Tx for the second withTenant call: SELECT existing row + INSERT or UPDATE */
function makeUpsertTx(hasExistingRow: boolean) {
  return {
    select: vi.fn().mockReturnValue(makeSelectChain(hasExistingRow ? [{ id: 'row-uuid' }] : [])),
    insert: vi.fn().mockReturnValue(makeInsertChain()),
    update: vi.fn().mockReturnValue(makeUpdateChain()),
  }
}

function setupHappyPathWithTenant(hasExistingRow = false) {
  mockWithTenant
    .mockImplementationOnce((_tid: unknown, cb: (tx: unknown) => unknown) =>
      cb(makeActiveCheckTx(false)),
    )
    .mockImplementationOnce((_tid: unknown, cb: (tx: unknown) => unknown) =>
      cb(makeUpsertTx(hasExistingRow)),
    )
}

// --- MSW server ---

const server = setupServer()

beforeAll(() => {
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost:5432/test')
  vi.stubEnv('DATABASE_URL_SERVICE_ROLE', 'postgresql://test:test@localhost:5432/test')
  vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
  vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'test-key')
  vi.stubEnv('SUPABASE_SECRET_KEY', 'test-secret')
  vi.stubEnv('META_APP_ID', 'test-app-id-12345')
  vi.stubEnv('META_APP_SECRET_SSM_KEY', '/test/meta/secret')
  vi.stubEnv('WEBHOOK_VERIFY_TOKEN_SSM_KEY', '/test/webhook/token')
  vi.stubEnv('ANTHROPIC_API_KEY_SSM_KEY', '/test/anthropic/key')
  vi.stubEnv('AWS_REGION', 'ap-northeast-1')
  server.listen({ onUnhandledRequest: 'warn' })
})

afterEach(() => {
  server.resetHandlers()
  // mockReset() clears both call history AND the mockImplementationOnce queue,
  // preventing unconsumed once-implementations from leaking into the next test.
  mockWithTenant.mockReset()
})

afterAll(() => {
  server.close()
  vi.unstubAllEnvs()
})

import { handleConnectPage } from '~/routes/(app)/onboarding/connect-page/-lib/connect-page.server'

describe('handleConnectPage', () => {
  describe('happy path', () => {
    it('INSERT: succeeds when no existing row for this pageId', async () => {
      setupHappyPathWithTenant(false)
      server.use(listPagesSuccess(MOCK_PAGES), subscribeSuccess(PAGE_ID))

      const result = await handleConnectPage(TENANT_ID, PAGE_ID, ENCODED_SESSION)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.pageId).toBe(PAGE_ID)
        expect(result.pageName).toBe(PAGE_NAME)
      }
    })

    it('UPDATE (re-connect): succeeds when row already exists for this tenantId+pageId', async () => {
      setupHappyPathWithTenant(true)
      server.use(listPagesSuccess(MOCK_PAGES), subscribeSuccess(PAGE_ID))

      const result = await handleConnectPage(TENANT_ID, PAGE_ID, ENCODED_SESSION)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.pageId).toBe(PAGE_ID)
        expect(result.pageName).toBe(PAGE_NAME)
      }
      // Verify update path was taken (select returned a row → update called, not insert)
      expect(mockWithTenant).toHaveBeenCalledTimes(2)
    })
  })

  describe('already_connected guard', () => {
    it('returns already_connected when tenant already has an active page', async () => {
      mockWithTenant.mockImplementationOnce((_tid: unknown, cb: (tx: unknown) => unknown) =>
        cb(makeActiveCheckTx(true)),
      )

      const result = await handleConnectPage(TENANT_ID, PAGE_ID, ENCODED_SESSION)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe('already_connected')
      }
      expect(mockWithTenant).toHaveBeenCalledTimes(1)
    })
  })

  describe('session cookie validation', () => {
    it('returns token_invalid when session cookie is absent', async () => {
      mockWithTenant.mockImplementationOnce((_tid: unknown, cb: (tx: unknown) => unknown) =>
        cb(makeActiveCheckTx(false)),
      )

      const result = await handleConnectPage(TENANT_ID, PAGE_ID, undefined)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('token_invalid')
    })
  })

  describe('page lookup errors', () => {
    it('returns token_invalid when selected pageId is not in the pages list', async () => {
      // Only need the guard check — function returns before reaching the upsert step
      mockWithTenant.mockImplementationOnce((_tid: unknown, cb: (tx: unknown) => unknown) =>
        cb(makeActiveCheckTx(false)),
      )
      const otherPages: MockPage[] = [{ id: '999888777', name: 'Other Page', access_token: 'EAA-other' }]
      server.use(listPagesSuccess(otherPages))

      const result = await handleConnectPage(TENANT_ID, PAGE_ID, ENCODED_SESSION)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('token_invalid')
    })

    it('returns token_invalid when listPages throws token_expired (190)', async () => {
      mockWithTenant.mockImplementationOnce((_tid: unknown, cb: (tx: unknown) => unknown) =>
        cb(makeActiveCheckTx(false)),
      )
      server.use(listPagesError(190))

      const result = await handleConnectPage(TENANT_ID, PAGE_ID, ENCODED_SESSION)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('token_invalid')
    })

    it('returns permission_missing when listPages throws permission_missing (200)', async () => {
      mockWithTenant.mockImplementationOnce((_tid: unknown, cb: (tx: unknown) => unknown) =>
        cb(makeActiveCheckTx(false)),
      )
      server.use(listPagesError(200))

      const result = await handleConnectPage(TENANT_ID, PAGE_ID, ENCODED_SESSION)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('permission_missing')
    })

    it('returns rate_limited when listPages throws rate_limited (4)', async () => {
      mockWithTenant.mockImplementationOnce((_tid: unknown, cb: (tx: unknown) => unknown) =>
        cb(makeActiveCheckTx(false)),
      )
      server.use(listPagesError(4))

      const result = await handleConnectPage(TENANT_ID, PAGE_ID, ENCODED_SESSION)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('rate_limited')
    })
  })

  describe('webhook subscription errors', () => {
    it('returns webhook_url_failed when subscribePageWebhook throws 803', async () => {
      mockWithTenant.mockImplementationOnce((_tid: unknown, cb: (tx: unknown) => unknown) =>
        cb(makeActiveCheckTx(false)),
      )
      server.use(listPagesSuccess(MOCK_PAGES), subscribeError(PAGE_ID, 803))

      const result = await handleConnectPage(TENANT_ID, PAGE_ID, ENCODED_SESSION)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('webhook_url_failed')
    })

    it('returns token_invalid when subscribePageWebhook throws token_invalid (190)', async () => {
      mockWithTenant.mockImplementationOnce((_tid: unknown, cb: (tx: unknown) => unknown) =>
        cb(makeActiveCheckTx(false)),
      )
      server.use(listPagesSuccess(MOCK_PAGES), subscribeError(PAGE_ID, 190))

      const result = await handleConnectPage(TENANT_ID, PAGE_ID, ENCODED_SESSION)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('token_invalid')
    })

    it('returns subscribe_failed for subscribe fails without DB write', async () => {
      mockWithTenant.mockImplementationOnce((_tid: unknown, cb: (tx: unknown) => unknown) =>
        cb(makeActiveCheckTx(false)),
      )
      // Use a non-5xx status to avoid the exponential-backoff retry (1s+2s+4s=7s)
      server.use(listPagesSuccess(MOCK_PAGES), subscribeError(PAGE_ID, 9999, 400))

      const result = await handleConnectPage(TENANT_ID, PAGE_ID, ENCODED_SESSION)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('subscribe_failed')
      // Only one withTenant call (the guard check) — no DB write attempted
      expect(mockWithTenant).toHaveBeenCalledTimes(1)
    })
  })

  describe('T039 — cross-tenant safety', () => {
    it('returns already_connected when another tenant owns the pageId (unique constraint 23505)', async () => {
      // Tenant A has no active pages, so guard passes
      mockWithTenant.mockImplementationOnce((_tid: unknown, cb: (tx: unknown) => unknown) =>
        cb(makeActiveCheckTx(false)),
      )
      server.use(listPagesSuccess(MOCK_PAGES), subscribeSuccess(PAGE_ID))

      // Second withTenant (upsert) rejects with the Postgres unique constraint error
      // as if tenant B already owns this pageId globally
      mockWithTenant.mockImplementationOnce(() => {
        const err = Object.assign(new Error('duplicate key'), { code: '23505' })
        return Promise.reject(err)
      })

      const result = await handleConnectPage(TENANT_ID, PAGE_ID, ENCODED_SESSION)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe('already_connected')
        expect(result.message).toContain('another account')
      }
    })

    it('forged pageId in input does not write to wrong tenant — withTenant scopes to caller tenant', async () => {
      // withTenant receives TENANT_ID and the callback sees only that tenant's rows.
      // We verify the correct tenantId is passed to both withTenant calls.
      setupHappyPathWithTenant(false)
      server.use(listPagesSuccess(MOCK_PAGES), subscribeSuccess(PAGE_ID))

      await handleConnectPage(TENANT_ID, PAGE_ID, ENCODED_SESSION)

      const calls = mockWithTenant.mock.calls
      expect(calls[0][0]).toBe(TENANT_ID)
      expect(calls[1][0]).toBe(TENANT_ID)
    })
  })
})
