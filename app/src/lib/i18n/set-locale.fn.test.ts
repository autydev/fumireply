import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockSetCookie = vi.fn()
vi.mock('@tanstack/react-start/server', () => ({
  setCookie: mockSetCookie,
}))

describe('performSetLocale', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sets fumireply_locale cookie with correct attributes for "en"', async () => {
    const { performSetLocale } = await import('./set-locale.fn')
    const result = await performSetLocale({ locale: 'en' })

    expect(mockSetCookie).toHaveBeenCalledWith('fumireply_locale', 'en', {
      path: '/',
      maxAge: 31536000,
      sameSite: 'lax',
      secure: true,
    })
    expect(result).toEqual({ ok: true, locale: 'en' })
  })

  it('sets fumireply_locale cookie with correct attributes for "ja"', async () => {
    const { performSetLocale } = await import('./set-locale.fn')
    const result = await performSetLocale({ locale: 'ja' })

    expect(mockSetCookie).toHaveBeenCalledWith('fumireply_locale', 'ja', expect.objectContaining({
      path: '/',
      maxAge: 31536000,
      sameSite: 'lax',
      secure: true,
    }))
    expect(result).toEqual({ ok: true, locale: 'ja' })
  })

  it('does NOT set httpOnly (client-side Paraglide must read the cookie)', async () => {
    const { performSetLocale } = await import('./set-locale.fn')
    await performSetLocale({ locale: 'en' })

    const callArgs = mockSetCookie.mock.calls[0][2] as Record<string, unknown>
    expect(callArgs).not.toHaveProperty('httpOnly')
  })
})
