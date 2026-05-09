// @vitest-environment node
// T036 + T039: Integration tests for handleConnectPage using MSW + DB mocks

process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test'
process.env.DATABASE_URL_SERVICE_ROLE = 'postgresql://test:test@localhost:5432/test'
process.env.SUPABASE_URL = 'https://test.supabase.co'
process.env.SUPABASE_PUBLISHABLE_KEY = 'test-pub'
process.env.SUPABASE_SECRET_KEY = 'test-secret'
process.env.META_APP_ID = 'test-app-id'
process.env.META_APP_SECRET_SSM_KEY = '/test/meta/secret'
process.env.WEBHOOK_VERIFY_TOKEN_SSM_KEY = '/test/verify-token'
process.env.ANTHROPIC_API_KEY_SSM_KEY = '/test/anthropic'
process.env.AWS_REGION = 'ap-northeast-1'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setupServer } from 'msw/node'
import {
  listPagesSuccess,
  subscribeWebhookSuccess,
  subscribeWebhookUrlFailed,
  DEFAULT_PAGE_ID,
  DEFAULT_PAGE_NAME,
} from '~/test/msw/facebook-handlers'

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

vi.mock('~/server/db/client', () => ({ db: {}, dbAdmin: {} }))

const mockWithTenant = vi.fn()
vi.mock('~/server/db/with-tenant', () => ({
  withTenant: (...args: unknown[]) => mockWithTenant(...args),
}))

const mockGetCookie = vi.fn()
vi.mock('@tanstack/react-start/server', () => ({
  getCookie: (...args: unknown[]) => mockGetCookie(...args),
  setCookie: vi.fn(),
}))

vi.mock('~/server/services/crypto', () => ({
  getMasterKey: vi.fn().mockResolvedValue(Buffer.alloc(32)),
  decryptToken: vi.fn().mockReturnValue('long-user-token'),
  encryptToken: vi.fn().mockReturnValue(Buffer.from('encrypted-page-token')),
}))

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  vi.clearAllMocks()
})
afterAll(() => server.close())

import { handleConnectPage } from '~/routes/(app)/onboarding/connect-page/-lib/connect-page.server'
import { decryptToken, encryptToken } from '~/server/services/crypto'

const SESSION_COOKIE_VALUE = Buffer.from('encrypted-long-token').toString('base64')

/** Build a withTenant tx mock that returns empty arrays for guard/row checks */
function buildTxReturningEmpty() {
  const tx = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
  }
  return tx
}

describe('handleConnectPage happy path (T036)', () => {
  it('decrypts session, fetches page, subscribes webhook, encrypts token, upserts DB', async () => {
    server.use(listPagesSuccess, subscribeWebhookSuccess)
    mockGetCookie.mockReturnValue(SESSION_COOKIE_VALUE)
    mockWithTenant.mockImplementation(async (_tid: string, cb: (tx: unknown) => Promise<unknown>) =>
      cb(buildTxReturningEmpty()),
    )

    const result = await handleConnectPage(TENANT_ID, DEFAULT_PAGE_ID)

    expect(result).toEqual({ ok: true, pageId: DEFAULT_PAGE_ID, pageName: DEFAULT_PAGE_NAME })
    expect(decryptToken).toHaveBeenCalled()
    expect(encryptToken).toHaveBeenCalled()
    expect(mockWithTenant).toHaveBeenCalledTimes(2) // guard check + upsert
  })
})

describe('handleConnectPage error cases (T036)', () => {
  it('returns already_connected when active page exists for tenant', async () => {
    mockGetCookie.mockReturnValue(SESSION_COOKIE_VALUE)
    mockWithTenant.mockImplementation(async (_tid: string, cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: 'active-page-id' }]),
            }),
          }),
        }),
      }
      return cb(tx)
    })

    const result = await handleConnectPage(TENANT_ID, DEFAULT_PAGE_ID)
    expect(result).toEqual({ ok: false, error: 'already_connected', message: expect.any(String) })
    expect(mockWithTenant).toHaveBeenCalledTimes(1)
  })

  it('returns token_invalid when fb_connect_session cookie is absent', async () => {
    mockGetCookie.mockReturnValue(undefined)
    mockWithTenant.mockImplementation(async (_tid: string, cb: (tx: unknown) => Promise<unknown>) =>
      cb(buildTxReturningEmpty()),
    )

    const result = await handleConnectPage(TENANT_ID, DEFAULT_PAGE_ID)
    expect(result).toEqual({ ok: false, error: 'token_invalid', message: expect.any(String) })
  })

  it('returns subscribe error when Webhook subscription fails', async () => {
    server.use(listPagesSuccess, subscribeWebhookUrlFailed)
    mockGetCookie.mockReturnValue(SESSION_COOKIE_VALUE)
    mockWithTenant.mockImplementation(async (_tid: string, cb: (tx: unknown) => Promise<unknown>) =>
      cb(buildTxReturningEmpty()),
    )

    const result = await handleConnectPage(TENANT_ID, DEFAULT_PAGE_ID)
    expect(result).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringMatching(/webhook_url_failed|subscribe_failed/) }),
    )
    expect(mockWithTenant).toHaveBeenCalledTimes(1)
  })
})

// T039: Cross-tenant safety — handleConnectPage always forwards the tenantId it receives
// to withTenant, and connectPageFn passes context.user.tenantId (not user input) to it.
describe('handleConnectPage cross-tenant safety (T039)', () => {
  it('withTenant is called with the tenantId argument on every DB access', async () => {
    server.use(listPagesSuccess, subscribeWebhookSuccess)
    mockGetCookie.mockReturnValue(SESSION_COOKIE_VALUE)

    const capturedTenantIds: string[] = []
    mockWithTenant.mockImplementation(async (tenantId: string, cb: (tx: unknown) => Promise<unknown>) => {
      capturedTenantIds.push(tenantId)
      return cb(buildTxReturningEmpty())
    })

    await handleConnectPage(TENANT_ID, DEFAULT_PAGE_ID)

    expect(capturedTenantIds.length).toBeGreaterThan(0)
    expect(capturedTenantIds.every((id) => id === TENANT_ID)).toBe(true)
  })
})
