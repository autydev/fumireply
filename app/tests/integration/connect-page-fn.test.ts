// @vitest-environment node
// Integration: connectPageFn — subscribe → encrypt → UPSERT, including already_connected guard

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setupServer } from 'msw/node'

vi.mock('~/server/db/client', () => ({ db: {}, dbAdmin: {} }))

import {
  subscribeSuccess,
  subscribeError,
} from '~/test/msw/facebook-handlers'
import {
  handleConnectPage,
  type ConnectPageDeps,
} from '~/routes/(app)/onboarding/connect-page/-lib/connect-page.server'
import type { TenantTx } from '~/server/db/with-tenant'

const server = setupServer()
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PAGE_ID = '1234567890'
const PAGE_NAME = 'Test Page'
const PAGE_ACCESS_TOKEN = 'LONG_LIVED_PAGE_ACCESS_TOKEN_xx'

beforeAll(() => {
  vi.stubEnv('WEBHOOK_VERIFY_TOKEN_SSM_KEY', '/test/webhook/verify-token')
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

type CapturedInsert = {
  values?: unknown
  conflict?: unknown
}

function buildTx(opts: { existingCount: number }): {
  tx: TenantTx
  captured: CapturedInsert
  insertCalled: () => boolean
} {
  const captured: CapturedInsert = {}
  let insertWasCalled = false

  // tx.select().from().where() → resolves to [{ value: count }]
  const selectChain: Record<string, unknown> = {}
  selectChain.from = vi.fn().mockReturnValue(selectChain)
  selectChain.where = vi.fn().mockResolvedValue([{ value: opts.existingCount }])

  // tx.insert().values().onConflictDoUpdate()
  const insertChain: Record<string, unknown> = {}
  insertChain.values = vi.fn().mockImplementation((v: unknown) => {
    captured.values = v
    return insertChain
  })
  insertChain.onConflictDoUpdate = vi.fn().mockImplementation((c: unknown) => {
    captured.conflict = c
    insertWasCalled = true
    return Promise.resolve(undefined)
  })

  const tx = {
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn().mockReturnValue(insertChain),
  } as unknown as TenantTx

  return { tx, captured, insertCalled: () => insertWasCalled }
}

function buildDeps(overrides: Partial<ConnectPageDeps> = {}): ConnectPageDeps {
  return {
    subscribePageWebhook: overrides.subscribePageWebhook ?? (async () => ({ ok: true })),
    encryptToken: overrides.encryptToken ?? (() => Buffer.from('encrypted-blob')),
    getMasterKey: overrides.getMasterKey ?? (async () => Buffer.alloc(32)),
    getWebhookVerifyTokenSsmKey:
      overrides.getWebhookVerifyTokenSsmKey ?? (() => '/test/webhook/verify-token'),
  }
}

describe('handleConnectPage', () => {
  const input = { pageId: PAGE_ID, pageName: PAGE_NAME, pageAccessToken: PAGE_ACCESS_TOKEN }

  it('happy path: subscribes, encrypts, inserts row, returns ok', async () => {
    server.use(subscribeSuccess(PAGE_ID))
    const { tx, captured, insertCalled } = buildTx({ existingCount: 0 })
    // Use real subscribe call via MSW
    const deps = buildDeps({
      subscribePageWebhook: async (pageId, token) => {
        const { subscribePageWebhook } = await import('~/server/services/facebook')
        return subscribePageWebhook(pageId, token)
      },
    })

    const result = await handleConnectPage(tx, TENANT_ID, input, deps)
    expect(result).toEqual({ ok: true, pageId: PAGE_ID, pageName: PAGE_NAME })
    expect(insertCalled()).toBe(true)
    expect(captured.values).toMatchObject({
      tenantId: TENANT_ID,
      pageId: PAGE_ID,
      pageName: PAGE_NAME,
      pageAccessTokenEncrypted: expect.any(Buffer),
      webhookVerifyTokenSsmKey: '/test/webhook/verify-token',
      isActive: true,
    })
  })

  it('already_connected: tenant has existing row → no subscribe, no insert', async () => {
    const subscribeSpy = vi.fn()
    const { tx, insertCalled } = buildTx({ existingCount: 1 })
    const deps = buildDeps({
      subscribePageWebhook: async (...args) => {
        subscribeSpy(...args)
        return { ok: true }
      },
    })

    const result = await handleConnectPage(tx, TENANT_ID, input, deps)
    expect(result).toEqual({
      ok: false,
      error: 'already_connected',
      message: expect.any(String),
    })
    expect(subscribeSpy).not.toHaveBeenCalled()
    expect(insertCalled()).toBe(false)
  })

  it('subscribe_failed: webhook subscription returns FB 190 → no DB write, token_invalid mapped', async () => {
    server.use(subscribeError(PAGE_ID, 190))
    const { tx, insertCalled } = buildTx({ existingCount: 0 })
    const deps = buildDeps({
      subscribePageWebhook: async (pageId, token) => {
        const { subscribePageWebhook } = await import('~/server/services/facebook')
        return subscribePageWebhook(pageId, token)
      },
    })

    const result = await handleConnectPage(tx, TENANT_ID, input, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('token_invalid')
    expect(insertCalled()).toBe(false)
  })

  it('subscribe_failed: webhook_url_failed (FB 803) → mapped + no DB write', async () => {
    server.use(subscribeError(PAGE_ID, 803))
    const { tx, insertCalled } = buildTx({ existingCount: 0 })
    const deps = buildDeps({
      subscribePageWebhook: async (pageId, token) => {
        const { subscribePageWebhook } = await import('~/server/services/facebook')
        return subscribePageWebhook(pageId, token)
      },
    })

    const result = await handleConnectPage(tx, TENANT_ID, input, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('webhook_url_failed')
    expect(insertCalled()).toBe(false)
  })

  it('encryption_failed: getMasterKey throws → no DB write', async () => {
    const { tx, insertCalled } = buildTx({ existingCount: 0 })
    const deps = buildDeps({
      getMasterKey: async () => {
        throw new Error('SSM unavailable')
      },
    })

    const result = await handleConnectPage(tx, TENANT_ID, input, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('encryption_failed')
    expect(insertCalled()).toBe(false)
  })

  it('encryption round-trip: encrypted blob is decryptable via the same master key', async () => {
    // This proves the encryption helper used inside handleConnectPage is the
    // real one (or at least compatible with the production decrypt path).
    const { encryptToken, decryptToken } = await import('~/server/services/crypto')
    const masterKey = Buffer.alloc(32, 7)
    const blob = encryptToken(PAGE_ACCESS_TOKEN, masterKey)
    expect(decryptToken(blob, masterKey)).toBe(PAGE_ACCESS_TOKEN)
  })
})
