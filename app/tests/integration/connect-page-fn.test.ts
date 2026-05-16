// @vitest-environment node
// Integration (T036): connectPageFn — server-side resolution of page name + token
// from a user-entered pageId via the encrypted fb_connect_session cookie.
// Client only sends { pageId }; name/token are never trusted from the browser.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setupServer } from 'msw/node'
import {
  fetchPageSuccess,
  fetchPageNoToken,
  fetchPageError,
  subscribeSuccess,
  subscribeError,
} from '~/test/msw/facebook-handlers'
import type { TenantTx } from '~/server/db/with-tenant'

vi.mock('~/server/services/crypto', () => ({
  getMasterKey: vi.fn().mockResolvedValue(Buffer.alloc(32)),
  decryptToken: vi.fn().mockReturnValue('LONG_USER_TOKEN_DECRYPTED'),
  encryptToken: vi.fn().mockReturnValue(Buffer.from('ENCRYPTED_PAGE_TOKEN')),
}))

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PAGE_ID = '1234567890'
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

// Mock tx whose select() chain resolves in handleConnectPage's call order:
//   select #1 → reverse-guard active row
//   select #2 → existing (tenant_id, page_id) row for UPSERT decision
function buildTx(opts: {
  activeExists?: boolean
  existingForUpsert?: boolean
  insertRejectCode?: string
}) {
  const { activeExists = false, existingForUpsert = false, insertRejectCode } = opts
  let selectCall = 0
  const insert = vi.fn()
  const update = vi.fn()

  const makeSelectChain = () => {
    const idx = ++selectCall
    const chain: Record<string, unknown> = {}
    chain.from = vi.fn().mockReturnValue(chain)
    chain.where = vi.fn().mockReturnValue(chain)
    chain.limit = vi.fn().mockImplementation(() => {
      if (idx === 1) return Promise.resolve(activeExists ? [{ id: 'active-row' }] : [])
      if (idx === 2) return Promise.resolve(existingForUpsert ? [{ id: 'existing-row' }] : [])
      return Promise.resolve([])
    })
    return chain
  }

  const insertChain: Record<string, unknown> = {}
  insertChain.values = vi.fn().mockImplementation(() => {
    insert()
    if (insertRejectCode) return Promise.reject(Object.assign(new Error('pg'), { code: insertRejectCode }))
    return Promise.resolve(undefined)
  })

  const updateChain: Record<string, unknown> = {}
  updateChain.set = vi.fn().mockReturnValue(updateChain)
  updateChain.where = vi.fn().mockImplementation(() => {
    update()
    return Promise.resolve(undefined)
  })

  const tx = {
    select: vi.fn().mockImplementation(makeSelectChain),
    insert: vi.fn().mockReturnValue(insertChain),
    update: vi.fn().mockReturnValue(updateChain),
  } as unknown as TenantTx

  return { tx, calls: { insert, update } }
}

describe('connectPageFn integration — handleConnectPage', () => {
  it('happy path: resolves name/token server-side, subscribes, INSERTs, clears session', async () => {
    server.use(fetchPageSuccess(PAGE_ID, { name: 'Malbek Test Page' }), subscribeSuccess(PAGE_ID))
    const clearSession = vi.fn()
    const { tx, calls } = buildTx({})

    const result = await handleConnectPage(tx, TENANT_ID, { pageId: PAGE_ID }, {
      encodedSession: SESSION,
      clearSession,
    })

    expect(result).toEqual({ ok: true, pageId: PAGE_ID, pageName: 'Malbek Test Page' })
    expect(calls.insert).toHaveBeenCalledOnce()
    expect(calls.update).not.toHaveBeenCalled()
    expect(clearSession).toHaveBeenCalledOnce()
  })

  it('re-connect: existing (tenant,page) row → UPDATE, not INSERT', async () => {
    server.use(fetchPageSuccess(PAGE_ID), subscribeSuccess(PAGE_ID))
    const { tx, calls } = buildTx({ existingForUpsert: true })

    const result = await handleConnectPage(tx, TENANT_ID, { pageId: PAGE_ID }, {
      encodedSession: SESSION,
      clearSession: vi.fn(),
    })

    expect(result.ok).toBe(true)
    expect(calls.update).toHaveBeenCalledOnce()
    expect(calls.insert).not.toHaveBeenCalled()
  })

  it('missing session cookie → token_invalid, no Graph call, no DB write', async () => {
    const clearSession = vi.fn()
    const { tx, calls } = buildTx({})

    const result = await handleConnectPage(tx, TENANT_ID, { pageId: PAGE_ID }, {
      encodedSession: undefined,
      clearSession,
    })

    expect(result).toEqual({ ok: false, error: 'token_invalid', message: expect.any(String) })
    expect(calls.insert).not.toHaveBeenCalled()
    expect(clearSession).not.toHaveBeenCalled()
  })

  it('reverse guard: tenant already has an active page → already_connected, DB unchanged', async () => {
    const { tx, calls } = buildTx({ activeExists: true })

    const result = await handleConnectPage(tx, TENANT_ID, { pageId: PAGE_ID }, {
      encodedSession: SESSION,
      clearSession: vi.fn(),
    })

    expect(result).toEqual({ ok: false, error: 'already_connected', message: expect.any(String) })
    expect(calls.insert).not.toHaveBeenCalled()
    expect(calls.update).not.toHaveBeenCalled()
  })

  it('fetchPageWithToken 100 (page not found) → token_invalid, no DB write', async () => {
    server.use(fetchPageError(PAGE_ID, 100))
    const { tx, calls } = buildTx({})

    const result = await handleConnectPage(tx, TENANT_ID, { pageId: PAGE_ID }, {
      encodedSession: SESSION,
      clearSession: vi.fn(),
    })

    expect(result).toEqual({ ok: false, error: 'token_invalid', message: expect.any(String) })
    expect(calls.insert).not.toHaveBeenCalled()
  })

  it('page found but no access_token field → permission_missing', async () => {
    server.use(fetchPageNoToken(PAGE_ID))
    const { tx } = buildTx({})

    const result = await handleConnectPage(tx, TENANT_ID, { pageId: PAGE_ID }, {
      encodedSession: SESSION,
      clearSession: vi.fn(),
    })

    expect(result).toEqual({ ok: false, error: 'permission_missing', message: expect.any(String) })
  })

  it('subscribe 803 → webhook_url_failed, no DB write', async () => {
    server.use(fetchPageSuccess(PAGE_ID), subscribeError(PAGE_ID, 803))
    const { tx, calls } = buildTx({})

    const result = await handleConnectPage(tx, TENANT_ID, { pageId: PAGE_ID }, {
      encodedSession: SESSION,
      clearSession: vi.fn(),
    })

    expect(result).toEqual({ ok: false, error: 'webhook_url_failed', message: expect.any(String) })
    expect(calls.insert).not.toHaveBeenCalled()
  })

  it('subscribe generic error → subscribe_failed', async () => {
    server.use(fetchPageSuccess(PAGE_ID), subscribeError(PAGE_ID, 2))
    const { tx } = buildTx({})

    const result = await handleConnectPage(tx, TENANT_ID, { pageId: PAGE_ID }, {
      encodedSession: SESSION,
      clearSession: vi.fn(),
    })

    expect(result).toEqual({ ok: false, error: 'subscribe_failed', message: expect.any(String) })
  })
})
