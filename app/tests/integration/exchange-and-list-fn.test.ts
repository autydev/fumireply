// @vitest-environment node
// Integration: handleExchangeAndList — MSW for Graph API, mocked SSM + crypto

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setupServer } from 'msw/node'
import {
  exchangeTokenSuccess,
  exchangeTokenError,
  listPagesSuccess,
  listPagesEmpty,
  listPagesError,
  type MockPage,
} from '~/test/msw/facebook-handlers'

const mockSsm = vi.fn<() => Promise<string>>().mockResolvedValue('test-app-secret')

vi.mock('~/server/services/ssm', () => ({ getSsmParameter: (...args: unknown[]) => mockSsm(...args) }))
vi.mock('~/server/services/crypto', () => ({
  getMasterKey: vi.fn().mockResolvedValue(Buffer.alloc(32)),
  encryptToken: vi.fn().mockReturnValue(Buffer.from('encrypted-long-token')),
}))
vi.mock('~/server/db/client', () => ({ db: {}, dbAdmin: {} }))

const MOCK_PAGES: MockPage[] = [
  { id: '111222333', name: 'Test Page', access_token: 'EAA-page-token-1' },
  { id: '444555666', name: 'Second Page', access_token: 'EAA-page-token-2' },
]

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
  vi.clearAllMocks()
  mockSsm.mockResolvedValue('test-app-secret')
})

afterAll(() => {
  server.close()
  vi.unstubAllEnvs()
})

import { handleExchangeAndList } from '~/routes/(app)/onboarding/connect-page/-lib/exchange-and-list.server'

describe('handleExchangeAndList', () => {
  it('happy path: returns pages list and encrypted token', async () => {
    server.use(exchangeTokenSuccess(), listPagesSuccess(MOCK_PAGES))

    const { result, encryptedLongToken } = await handleExchangeAndList('short_lived_token_abc123')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.pages).toEqual([
        { id: '111222333', name: 'Test Page' },
        { id: '444555666', name: 'Second Page' },
      ])
    }
    expect(encryptedLongToken).toBeDefined()
    expect(encryptedLongToken).toBeInstanceOf(Buffer)
  })

  it('no_pages: returns no_pages when page list is empty', async () => {
    server.use(exchangeTokenSuccess(), listPagesEmpty())

    const { result, encryptedLongToken } = await handleExchangeAndList('short_lived_token_abc123')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('no_pages')
    expect(encryptedLongToken).toBeUndefined()
  })

  it('token_expired: maps FB 190 from exchangeUserToken to token_expired', async () => {
    server.use(exchangeTokenError(190))

    const { result } = await handleExchangeAndList('short_lived_token_abc123')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('token_expired')
  })

  it('rate_limited: maps FB 4 from exchangeUserToken to rate_limited', async () => {
    server.use(exchangeTokenError(4))

    const { result } = await handleExchangeAndList('short_lived_token_abc123')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('rate_limited')
  })

  it('permission_missing: maps FB 200 from listPages to permission_missing', async () => {
    server.use(exchangeTokenSuccess(), listPagesError(200))

    const { result } = await handleExchangeAndList('short_lived_token_abc123')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('permission_missing')
  })

  it('token_expired: maps FB 190 from listPages to token_expired', async () => {
    server.use(exchangeTokenSuccess(), listPagesError(190))

    const { result } = await handleExchangeAndList('short_lived_token_abc123')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('token_expired')
  })

  it('rate_limited: maps FB 4 from listPages to rate_limited', async () => {
    server.use(exchangeTokenSuccess(), listPagesError(4))

    const { result } = await handleExchangeAndList('short_lived_token_abc123')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('rate_limited')
  })

  it('meta_unavailable: maps unknown FB error code to meta_unavailable', async () => {
    server.use(exchangeTokenError(9999))

    const { result } = await handleExchangeAndList('short_lived_token_abc123')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('meta_unavailable')
  })
})
