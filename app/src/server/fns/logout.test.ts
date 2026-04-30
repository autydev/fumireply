import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.SUPABASE_URL = 'https://test.supabase.co'
process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key'

const mockGetCookie = vi.fn()
const mockSetCookie = vi.fn()
vi.mock('@tanstack/react-start/server', () => ({
  getCookie: mockGetCookie,
  setCookie: mockSetCookie,
}))

const mockSetSession = vi.fn()
const mockSignOut = vi.fn()
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn().mockReturnValue({
    auth: {
      setSession: mockSetSession,
      signOut: mockSignOut,
    },
  }),
}))

describe('performLogout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSetSession.mockResolvedValue({ data: { session: null }, error: null })
    mockSignOut.mockResolvedValue({ error: null })
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('calls setSession + signOut and clears cookies when both cookies exist', async () => {
    mockGetCookie.mockImplementation((name: string) => {
      if (name === 'sb-access-token') return 'access-tok'
      if (name === 'sb-refresh-token') return 'refresh-tok'
      return undefined
    })

    const { performLogout } = await import('./logout.fn')
    const result = await performLogout()

    expect(mockSetSession).toHaveBeenCalledWith({
      access_token: 'access-tok',
      refresh_token: 'refresh-tok',
    })
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'global' })
    expect(mockSetCookie).toHaveBeenCalledWith(
      'sb-access-token',
      '',
      expect.objectContaining({ maxAge: 0, httpOnly: true }),
    )
    expect(mockSetCookie).toHaveBeenCalledWith(
      'sb-refresh-token',
      '',
      expect.objectContaining({ maxAge: 0, httpOnly: true }),
    )
    expect(result).toEqual({ ok: true })
  })

  it('skips signOut but still clears cookies when cookies are absent', async () => {
    mockGetCookie.mockReturnValue(undefined)

    const { performLogout } = await import('./logout.fn')
    const result = await performLogout()

    expect(mockSetSession).not.toHaveBeenCalled()
    expect(mockSignOut).not.toHaveBeenCalled()
    expect(mockSetCookie).toHaveBeenCalledWith(
      'sb-access-token',
      '',
      expect.objectContaining({ maxAge: 0 }),
    )
    expect(mockSetCookie).toHaveBeenCalledWith(
      'sb-refresh-token',
      '',
      expect.objectContaining({ maxAge: 0 }),
    )
    expect(result).toEqual({ ok: true })
  })

  it('clears cookies even when signOut throws', async () => {
    mockGetCookie.mockImplementation((name: string) => {
      if (name === 'sb-access-token') return 'access-tok'
      if (name === 'sb-refresh-token') return 'refresh-tok'
      return undefined
    })
    mockSignOut.mockRejectedValueOnce(new Error('Network error'))

    const { performLogout } = await import('./logout.fn')
    const result = await performLogout()

    expect(mockSetCookie).toHaveBeenCalledWith(
      'sb-access-token',
      '',
      expect.objectContaining({ maxAge: 0 }),
    )
    expect(mockSetCookie).toHaveBeenCalledWith(
      'sb-refresh-token',
      '',
      expect.objectContaining({ maxAge: 0 }),
    )
    expect(result).toEqual({ ok: true })
  })
})
