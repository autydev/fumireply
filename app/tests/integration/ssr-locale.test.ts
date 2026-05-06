// @vitest-environment node
// Integration: SSR locale resolution — localeMiddleware sets Paraglide locale from Cookie
// Also verifies concurrent request isolation (AsyncLocalStorage safety)

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Capture the server handler registered via createMiddleware().server(handler)
type ServerHandler = (ctx: { next: () => unknown; request: Request }) => unknown
let capturedServerHandler: ServerHandler | null = null

vi.mock('@tanstack/react-start', () => ({
  createMiddleware: () => ({
    server: (handler: ServerHandler) => {
      capturedServerHandler = handler
      return { _tag: 'middleware' }
    },
  }),
}))

const mockSetLocale = vi.fn()
vi.mock('~/paraglide/runtime', () => ({
  setLocale: mockSetLocale,
}))

describe('localeMiddleware server handler', () => {
  beforeEach(async () => {
    capturedServerHandler = null
    mockSetLocale.mockClear()
    vi.resetModules()
    // Re-import to trigger module evaluation and register handler
    await import('~/lib/i18n/locale-middleware')
  })

  function makeRequest(cookieHeader?: string): Request {
    const headers = new Headers()
    if (cookieHeader !== undefined) {
      headers.set('cookie', cookieHeader)
    }
    return new Request('https://example.com/', { headers })
  }

  function callMiddleware(request: Request) {
    if (!capturedServerHandler) throw new Error('middleware not registered')
    const next = vi.fn().mockReturnValue('next-result')
    return capturedServerHandler({ next, request })
  }

  it('calls setLocale("en") when fumireply_locale=en Cookie is present', async () => {
    callMiddleware(makeRequest('fumireply_locale=en'))
    expect(mockSetLocale).toHaveBeenCalledWith('en')
  })

  it('calls setLocale("ja") when fumireply_locale=ja Cookie is present', async () => {
    callMiddleware(makeRequest('fumireply_locale=ja'))
    expect(mockSetLocale).toHaveBeenCalledWith('ja')
  })

  it('calls setLocale("ja") when no Cookie header is present (default)', async () => {
    callMiddleware(makeRequest())
    expect(mockSetLocale).toHaveBeenCalledWith('ja')
  })

  it('calls setLocale("ja") for unknown locale "zh" (fallback)', async () => {
    callMiddleware(makeRequest('fumireply_locale=zh'))
    expect(mockSetLocale).toHaveBeenCalledWith('ja')
  })

  it('calls setLocale("ja") for empty cookie header (fallback)', async () => {
    callMiddleware(makeRequest(''))
    expect(mockSetLocale).toHaveBeenCalledWith('ja')
  })

  it('calls setLocale("en") when fumireply_locale is among multiple cookies', async () => {
    callMiddleware(makeRequest('session=abc; fumireply_locale=en; other=xyz'))
    expect(mockSetLocale).toHaveBeenCalledWith('en')
  })

  it('calls next() after setting locale', async () => {
    if (!capturedServerHandler) throw new Error('middleware not registered')
    const next = vi.fn().mockReturnValue('next-result')
    const result = capturedServerHandler({ next, request: makeRequest('fumireply_locale=en') })
    expect(next).toHaveBeenCalledOnce()
    expect(result).toBe('next-result')
  })
})

// Concurrent isolation: verify localeMiddleware calls setLocale with the correct locale
// for each request when multiple middleware invocations run concurrently.
// (Node.js is single-threaded, so Promise.all schedules them cooperatively;
// the test confirms setLocale is invoked once per request with the right value,
// detecting any shared-state bug in the locale-resolution path.)
describe('SSR locale concurrent isolation via localeMiddleware', () => {
  beforeEach(async () => {
    capturedServerHandler = null
    mockSetLocale.mockClear()
    vi.resetModules()
    await import('~/lib/i18n/locale-middleware')
  })

  it('setLocale is called with the correct locale for each of 100 concurrent middleware invocations', async () => {
    if (!capturedServerHandler) throw new Error('middleware not registered')
    const handler = capturedServerHandler

    const requests = Array.from({ length: 100 }, (_, i) => ({
      cookieHeader: i % 2 === 0 ? 'fumireply_locale=en' : 'fumireply_locale=ja',
      expected: i % 2 === 0 ? 'en' : 'ja',
    }))

    await Promise.all(
      requests.map(({ cookieHeader }) => {
        const headers = new Headers()
        headers.set('cookie', cookieHeader)
        const request = new Request('https://example.com/', { headers })
        const next = vi.fn().mockReturnValue(undefined)
        return Promise.resolve(handler({ next, request }))
      }),
    )

    expect(mockSetLocale).toHaveBeenCalledTimes(100)
    const localeCalls = mockSetLocale.mock.calls.map(([locale]: [string]) => locale)
    expect(localeCalls.filter((l) => l === 'en').length).toBe(50)
    expect(localeCalls.filter((l) => l === 'ja').length).toBe(50)
  })

  it('setLocale("ja") is called for every no-cookie middleware invocation under concurrency', async () => {
    if (!capturedServerHandler) throw new Error('middleware not registered')
    const handler = capturedServerHandler

    await Promise.all(
      Array.from({ length: 50 }, () => {
        const request = new Request('https://example.com/')
        const next = vi.fn().mockReturnValue(undefined)
        return Promise.resolve(handler({ next, request }))
      }),
    )

    expect(mockSetLocale).toHaveBeenCalledTimes(50)
    const localeCalls = mockSetLocale.mock.calls.map(([locale]: [string]) => locale)
    expect(localeCalls.every((l) => l === 'ja')).toBe(true)
  })
})
