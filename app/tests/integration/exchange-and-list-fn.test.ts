// @vitest-environment node
// Integration (T035): exchangeAndListFn — short→long user token exchange,
// encrypted httpOnly fb_connect_session cookie, and Graph error mapping.
// The page list is intentionally NOT returned (server-side cookie only).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setupServer } from 'msw/node'
import {
  exchangeTokenSuccess,
  exchangeTokenError,
} from '~/test/msw/facebook-handlers'

const { mockSetCookie } = vi.hoisted(() => ({ mockSetCookie: vi.fn() }))
vi.mock('@tanstack/react-start/server', () => ({
  setCookie: mockSetCookie,
}))
vi.mock('~/server/services/ssm', () => ({
  getSsmParameter: vi.fn().mockResolvedValue('APP_SECRET_VALUE'),
}))
vi.mock('~/server/services/crypto', () => ({
  getMasterKey: vi.fn().mockResolvedValue(Buffer.alloc(32)),
  encryptToken: vi.fn().mockReturnValue(Buffer.from('ENCRYPTED_LONG_TOKEN')),
}))

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

import { performExchangeAndList, SESSION_COOKIE } from '~/routes/(app)/onboarding/connect-page/-lib/exchange-and-list.server'

describe('exchangeAndListFn integration — performExchangeAndList', () => {
  it('happy path: returns { ok: true } and sets the encrypted httpOnly session cookie (no page list)', async () => {
    server.use(exchangeTokenSuccess({ token: 'LONG_USER_TOKEN_XYZ' }))

    const result = await performExchangeAndList({ shortLivedUserToken: 'short-token-aaaaaaaaaaaaaaaaaaaa' })

    expect(result).toEqual({ ok: true })
    // crucially: no `pages` array on the response body
    expect(result).not.toHaveProperty('pages')

    expect(mockSetCookie).toHaveBeenCalledOnce()
    const [name, value, opts] = mockSetCookie.mock.calls[0]
    expect(name).toBe(SESSION_COOKIE)
    expect(name).toBe('fb_connect_session')
    expect(typeof value).toBe('string')
    expect(value.length).toBeGreaterThan(0)
    expect(opts).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 600,
    })
  })

  it('token_expired: Graph code 190 → { ok:false, error:"token_expired" }, no cookie', async () => {
    server.use(exchangeTokenError(190))

    const result = await performExchangeAndList({ shortLivedUserToken: 'expired-token-aaaaaaaaaaaaaaaa' })

    expect(result).toEqual({ ok: false, error: 'token_expired', message: expect.any(String) })
    expect(mockSetCookie).not.toHaveBeenCalled()
  })

  it('rate_limited: Graph code 4 → { ok:false, error:"rate_limited" }', async () => {
    server.use(exchangeTokenError(4))

    const result = await performExchangeAndList({ shortLivedUserToken: 'rate-limited-aaaaaaaaaaaaaaaaa' })

    expect(result).toEqual({ ok: false, error: 'rate_limited', message: expect.any(String) })
    expect(mockSetCookie).not.toHaveBeenCalled()
  })

  it('meta_unavailable: unmapped Graph code (100) → { ok:false, error:"meta_unavailable" }', async () => {
    server.use(exchangeTokenError(100))

    const result = await performExchangeAndList({ shortLivedUserToken: 'bad-param-aaaaaaaaaaaaaaaaaaaa' })

    expect(result).toEqual({ ok: false, error: 'meta_unavailable', message: expect.any(String) })
    expect(mockSetCookie).not.toHaveBeenCalled()
  })
})
