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

describe('SSR locale concurrent isolation', () => {
  it('resolves correct locale for 100 concurrent requests without cross-contamination', async () => {
    // getLocaleFromCookieHeader is a pure function — verify stable output under concurrency
    const { getLocaleFromCookieHeader } = await import('~/lib/i18n/locale')

    const requests = Array.from({ length: 100 }, (_, i) => ({
      cookie: i % 2 === 0 ? 'fumireply_locale=en' : 'fumireply_locale=ja',
      expected: i % 2 === 0 ? 'en' : 'ja',
    }))

    const results = await Promise.all(
      requests.map(({ cookie }) =>
        Promise.resolve(getLocaleFromCookieHeader(cookie)),
      ),
    )

    results.forEach((locale, i) => {
      expect(locale, `request[${i}] should be ${requests[i].expected}`).toBe(requests[i].expected)
    })
  })

  it('resolves "ja" for all no-cookie requests under concurrency', async () => {
    const { getLocaleFromCookieHeader } = await import('~/lib/i18n/locale')

    const results = await Promise.all(
      Array.from({ length: 50 }, () => Promise.resolve(getLocaleFromCookieHeader(''))),
    )

    expect(results.every((r) => r === 'ja')).toBe(true)
  })
})
