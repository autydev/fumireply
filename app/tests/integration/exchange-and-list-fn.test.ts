// @vitest-environment node
// Integration: exchangeAndListFn — Graph API + token exchange wrapper composition

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setupServer } from 'msw/node'

vi.mock('~/server/services/ssm', () => ({
  getSsmParameter: vi.fn().mockResolvedValue('test-app-secret'),
  clearSsmCache: vi.fn(),
}))

import {
  exchangeTokenSuccess,
  exchangeTokenError,
  exchangeTokenServerError,
  listPagesSuccess,
  listPagesEmpty,
  listPagesError,
} from '~/test/msw/facebook-handlers'
import { handleExchangeAndList } from '~/routes/(app)/onboarding/connect-page/-lib/exchange-and-list.server'

const server = setupServer()

beforeAll(() => {
  vi.stubEnv('VITE_FB_APP_ID', '1234567890')
  vi.stubEnv('META_APP_SECRET_SSM_KEY', '/test/meta/app-secret')
  vi.stubEnv('AWS_REGION', 'ap-northeast-1')
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => server.resetHandlers())
afterAll(() => {
  server.close()
  vi.unstubAllEnvs()
})

const SHORT_TOKEN = 'SHORT_LIVED_USER_TOKEN_xxxxxxxxxxxx'

describe('handleExchangeAndList', () => {
  it('returns ok with pages on happy path', async () => {
    server.use(
      exchangeTokenSuccess({ token: 'LONG_USER_TOKEN' }),
      listPagesSuccess([
        { id: '1111111111', name: 'Test Page', access_token: 'PAGE_TOKEN_XXX' },
      ]),
    )

    const result = await handleExchangeAndList(SHORT_TOKEN)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.pages).toEqual([
        { id: '1111111111', name: 'Test Page', pageAccessToken: 'PAGE_TOKEN_XXX' },
      ])
    }
  })

  it('returns token_expired when exchange returns FB error 190', async () => {
    server.use(exchangeTokenError(190))
    const result = await handleExchangeAndList(SHORT_TOKEN)
    expect(result).toEqual({
      ok: false,
      error: 'token_expired',
      message: expect.any(String),
    })
  })

  it('returns permission_missing when /me/accounts returns FB error 200', async () => {
    server.use(exchangeTokenSuccess(), listPagesError(200))
    const result = await handleExchangeAndList(SHORT_TOKEN)
    expect(result).toEqual({
      ok: false,
      error: 'permission_missing',
      message: expect.any(String),
    })
  })

  it('returns no_pages when /me/accounts returns empty data', async () => {
    server.use(exchangeTokenSuccess(), listPagesEmpty())
    const result = await handleExchangeAndList(SHORT_TOKEN)
    expect(result).toEqual({
      ok: false,
      error: 'no_pages',
      message: expect.any(String),
    })
  })

  it('returns rate_limited when /me/accounts returns FB error 4', async () => {
    server.use(exchangeTokenSuccess(), listPagesError(4))
    const result = await handleExchangeAndList(SHORT_TOKEN)
    expect(result).toEqual({
      ok: false,
      error: 'rate_limited',
      message: expect.any(String),
    })
  })

  it('returns meta_unavailable on persistent 5xx', async () => {
    server.use(exchangeTokenServerError(503))
    const result = await handleExchangeAndList(SHORT_TOKEN)
    expect(result).toEqual({
      ok: false,
      error: 'meta_unavailable',
      message: expect.any(String),
    })
  }, 30000)
})
