// @vitest-environment node
// Integration: setLocaleFn — happy path + Zod schema validation + Set-Cookie header attributes

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const mockSetCookie = vi.fn()
vi.mock('@tanstack/react-start/server', () => ({
  setCookie: mockSetCookie,
}))

describe('performSetLocale', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sets fumireply_locale cookie for "en" with correct attributes', async () => {
    const { performSetLocale } = await import('~/lib/i18n/set-locale.fn')
    const result = await performSetLocale({ locale: 'en' })

    expect(mockSetCookie).toHaveBeenCalledOnce()
    expect(mockSetCookie).toHaveBeenCalledWith('fumireply_locale', 'en', {
      path: '/',
      maxAge: 31536000,
      sameSite: 'lax',
      secure: true,
    })
    expect(result).toEqual({ ok: true, locale: 'en' })
  })

  it('sets fumireply_locale cookie for "ja" with correct attributes', async () => {
    const { performSetLocale } = await import('~/lib/i18n/set-locale.fn')
    const result = await performSetLocale({ locale: 'ja' })

    expect(mockSetCookie).toHaveBeenCalledOnce()
    expect(mockSetCookie).toHaveBeenCalledWith('fumireply_locale', 'ja', {
      path: '/',
      maxAge: 31536000,
      sameSite: 'lax',
      secure: true,
    })
    expect(result).toEqual({ ok: true, locale: 'ja' })
  })

  it('does NOT set httpOnly on the cookie (client Paraglide reads it)', async () => {
    const { performSetLocale } = await import('~/lib/i18n/set-locale.fn')
    await performSetLocale({ locale: 'en' })

    const cookieOptions = mockSetCookie.mock.calls[0][2] as Record<string, unknown>
    expect(cookieOptions).not.toHaveProperty('httpOnly')
  })

  it('uses COOKIE_NAME constant as the cookie key (read/write sync)', async () => {
    const { COOKIE_NAME } = await import('~/lib/i18n/locale')
    const { performSetLocale } = await import('~/lib/i18n/set-locale.fn')
    await performSetLocale({ locale: 'en' })

    const cookieKey = mockSetCookie.mock.calls[0][0] as string
    expect(cookieKey).toBe(COOKIE_NAME)
  })
})

// Import the same SetLocaleInput exported from the implementation so these tests
// verify the actual inputValidator schema used by setLocaleFn, not a re-created copy.
describe('setLocaleFn input schema (SetLocaleInput from implementation)', () => {
  it('accepts locale "en"', async () => {
    const { SetLocaleInput } = await import('~/lib/i18n/set-locale.fn')
    expect(() => SetLocaleInput.parse({ locale: 'en' })).not.toThrow()
  })

  it('accepts locale "ja"', async () => {
    const { SetLocaleInput } = await import('~/lib/i18n/set-locale.fn')
    expect(() => SetLocaleInput.parse({ locale: 'ja' })).not.toThrow()
  })

  it('rejects locale "fr"', async () => {
    const { SetLocaleInput } = await import('~/lib/i18n/set-locale.fn')
    expect(() => SetLocaleInput.parse({ locale: 'fr' })).toThrow(z.ZodError)
  })

  it('rejects empty string locale', async () => {
    const { SetLocaleInput } = await import('~/lib/i18n/set-locale.fn')
    expect(() => SetLocaleInput.parse({ locale: '' })).toThrow(z.ZodError)
  })

  it('rejects missing locale field', async () => {
    const { SetLocaleInput } = await import('~/lib/i18n/set-locale.fn')
    expect(() => SetLocaleInput.parse({})).toThrow(z.ZodError)
  })

  it('rejects null locale', async () => {
    const { SetLocaleInput } = await import('~/lib/i18n/set-locale.fn')
    expect(() => SetLocaleInput.parse({ locale: null })).toThrow(z.ZodError)
  })
})
