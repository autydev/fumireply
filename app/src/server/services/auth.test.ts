import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

process.env.SUPABASE_URL = 'https://test.supabase.co'
process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => {
  server.resetHandlers()
  vi.resetModules()
})
afterAll(() => server.close())

describe('verifyAccessToken', () => {
  it('returns user on valid token', async () => {
    server.use(
      http.get('https://test.supabase.co/auth/v1/user', () =>
        HttpResponse.json({
          id: 'user-uuid',
          email: 'test@example.com',
          user_metadata: { tenant_id: 'tenant-uuid', role: 'reviewer' },
        }),
      ),
    )
    const { verifyAccessToken } = await import('./auth')
    const user = await verifyAccessToken('valid-token')
    expect(user).not.toBeNull()
    expect(user?.id).toBe('user-uuid')
  })

  it('returns null on expired token', async () => {
    server.use(
      http.get('https://test.supabase.co/auth/v1/user', () =>
        HttpResponse.json({ message: 'JWT expired' }, { status: 401 }),
      ),
    )
    const { verifyAccessToken } = await import('./auth')
    const user = await verifyAccessToken('expired-token')
    expect(user).toBeNull()
  })
})

describe('refreshSession', () => {
  it('returns new tokens on valid refresh token', async () => {
    server.use(
      http.post('https://test.supabase.co/auth/v1/token', () =>
        HttpResponse.json({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          user: { id: 'user-uuid', email: 'test@example.com', user_metadata: {} },
          expires_in: 3600,
          token_type: 'bearer',
        }),
      ),
    )
    const { refreshSession } = await import('./auth')
    const result = await refreshSession('valid-refresh-token')
    expect(result).not.toBeNull()
    expect(result?.accessToken).toBe('new-access-token')
    expect(result?.refreshToken).toBe('new-refresh-token')
  })

  it('returns null on invalid refresh token', async () => {
    server.use(
      http.post('https://test.supabase.co/auth/v1/token', () =>
        HttpResponse.json({ message: 'Invalid refresh token' }, { status: 400 }),
      ),
    )
    const { refreshSession } = await import('./auth')
    const result = await refreshSession('invalid-refresh-token')
    expect(result).toBeNull()
  })
})
