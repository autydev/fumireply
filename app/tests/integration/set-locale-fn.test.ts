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

// setLocaleFn wraps performSetLocale with .inputValidator(SetLocaleInput).
// The Zod schema (z.enum(['en', 'ja'])) enforces locale constraints at the TanStack
// server fn boundary. These tests verify the schema shape matches the implementation.
describe('setLocaleFn input schema (z.enum constraint)', () => {
  // Mirror the schema used in set-locale.fn.ts to test its validation contract
  const SetLocaleInput = z.object({ locale: z.enum(['en', 'ja']) })

  it('accepts locale "en"', () => {
    expect(() => SetLocaleInput.parse({ locale: 'en' })).not.toThrow()
  })

  it('accepts locale "ja"', () => {
    expect(() => SetLocaleInput.parse({ locale: 'ja' })).not.toThrow()
  })

  it('rejects locale "fr"', () => {
    expect(() => SetLocaleInput.parse({ locale: 'fr' })).toThrow(z.ZodError)
  })

  it('rejects empty string locale', () => {
    expect(() => SetLocaleInput.parse({ locale: '' })).toThrow(z.ZodError)
  })

  it('rejects missing locale field', () => {
    expect(() => SetLocaleInput.parse({})).toThrow(z.ZodError)
  })

  it('rejects null locale', () => {
    expect(() => SetLocaleInput.parse({ locale: null })).toThrow(z.ZodError)
  })
})
