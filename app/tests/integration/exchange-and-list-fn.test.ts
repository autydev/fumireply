// @vitest-environment node
// T035: Integration tests for facebook.ts Graph API wrapper functions
// Tests exchangeUserToken, listPages, subscribePageWebhook with MSW handlers

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setupServer } from 'msw/node'
import {
  exchangeTokenSuccess,
  exchangeTokenExpired,
  exchangeTokenRateLimited,
  listPagesSuccess,
  listPagesEmpty,
  listPagesPermissionMissing,
  listPagesTokenExpired,
  listPagesRateLimited,
  subscribeWebhookSuccess,
  subscribeWebhookTokenInvalid,
  subscribeWebhookPermissionMissing,
  subscribeWebhookUrlFailed,
  DEFAULT_LONG_TOKEN,
  DEFAULT_PAGE_ID,
  DEFAULT_PAGE_NAME,
  DEFAULT_PAGE_ACCESS_TOKEN,
} from '~/test/msw/facebook-handlers'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

import { exchangeUserToken, listPages, subscribePageWebhook } from '~/server/services/facebook'

const SHORT_TOKEN = 'short-lived-user-token-xyz'
const APP_ID = 'test-app-id'
const APP_SECRET = 'test-app-secret'

describe('exchangeUserToken', () => {
  it('returns long-lived token and expires_in on success', async () => {
    server.use(exchangeTokenSuccess)
    const result = await exchangeUserToken(SHORT_TOKEN, APP_ID, APP_SECRET)
    expect(result).toEqual({ accessToken: DEFAULT_LONG_TOKEN, expiresIn: 5183999 })
  })

  it('throws token_expired on code 190', async () => {
    server.use(exchangeTokenExpired)
    await expect(exchangeUserToken(SHORT_TOKEN, APP_ID, APP_SECRET)).rejects.toThrow('token_expired')
  })

  it('throws rate_limited on code 4', async () => {
    server.use(exchangeTokenRateLimited)
    await expect(exchangeUserToken(SHORT_TOKEN, APP_ID, APP_SECRET)).rejects.toThrow('rate_limited')
  })
})

describe('listPages', () => {
  it('returns page array with id, name, pageAccessToken on success', async () => {
    server.use(listPagesSuccess)
    const pages = await listPages(DEFAULT_LONG_TOKEN)
    expect(pages).toEqual([
      { id: DEFAULT_PAGE_ID, name: DEFAULT_PAGE_NAME, pageAccessToken: DEFAULT_PAGE_ACCESS_TOKEN },
    ])
  })

  it('returns empty array when data is []', async () => {
    server.use(listPagesEmpty)
    const pages = await listPages(DEFAULT_LONG_TOKEN)
    expect(pages).toEqual([])
  })

  it('throws permission_missing on code 200', async () => {
    server.use(listPagesPermissionMissing)
    await expect(listPages(DEFAULT_LONG_TOKEN)).rejects.toThrow('permission_missing')
  })

  it('throws token_expired on code 190', async () => {
    server.use(listPagesTokenExpired)
    await expect(listPages(DEFAULT_LONG_TOKEN)).rejects.toThrow('token_expired')
  })

  it('throws rate_limited on code 4', async () => {
    server.use(listPagesRateLimited)
    await expect(listPages(DEFAULT_LONG_TOKEN)).rejects.toThrow('rate_limited')
  })
})

describe('subscribePageWebhook', () => {
  it('resolves without error on success', async () => {
    server.use(subscribeWebhookSuccess)
    await expect(subscribePageWebhook(DEFAULT_PAGE_ID, DEFAULT_PAGE_ACCESS_TOKEN)).resolves.toBeUndefined()
  })

  it('throws token_invalid on code 190', async () => {
    server.use(subscribeWebhookTokenInvalid)
    await expect(subscribePageWebhook(DEFAULT_PAGE_ID, DEFAULT_PAGE_ACCESS_TOKEN)).rejects.toThrow('token_invalid')
  })

  it('throws permission_missing on code 200', async () => {
    server.use(subscribeWebhookPermissionMissing)
    await expect(subscribePageWebhook(DEFAULT_PAGE_ID, DEFAULT_PAGE_ACCESS_TOKEN)).rejects.toThrow('permission_missing')
  })

  it('throws webhook_url_failed on code 803', async () => {
    server.use(subscribeWebhookUrlFailed)
    await expect(subscribePageWebhook(DEFAULT_PAGE_ID, DEFAULT_PAGE_ACCESS_TOKEN)).rejects.toThrow('webhook_url_failed')
  })
})
