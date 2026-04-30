import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { LoginResult } from '~/routes/(auth)/login/-lib/login.server'

process.env.SUPABASE_URL = 'https://test.supabase.co'
process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key'

// Mock setCookie / getCookie used by performLogin
const mockSetCookie = vi.fn()
vi.mock('@tanstack/react-start/server', () => ({
  getCookie: vi.fn(),
  setCookie: mockSetCookie,
}))

// Mock loginFn (component tests must not trigger real HTTP) while keeping
// the real performLogin accessible via vi.importActual for handler tests.
const loginFnMock = vi.hoisted(() => vi.fn<(args: { data: { email: string; password: string } }) => Promise<LoginResult>>())
vi.mock('~/routes/(auth)/login/-lib/login.fn', async () => {
  const actual = await vi.importActual<typeof import('~/routes/(auth)/login/-lib/login.fn')>(
    '~/routes/(auth)/login/-lib/login.fn',
  )
  return { ...actual, loginFn: loginFnMock }
})

// Mock useNavigate so component tests can assert navigation without a real router
const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  )
  return { ...actual, useNavigate: () => mockNavigate }
})

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => {
  server.resetHandlers()
  vi.clearAllMocks()
})
afterAll(() => server.close())

// ---------------------------------------------------------------------------
// performLogin handler tests — MSW intercepts Supabase HTTP, setCookie mocked
// ---------------------------------------------------------------------------

describe('performLogin handler', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('sets access + refresh cookies and returns user on successful login', async () => {
    server.use(
      http.post('https://test.supabase.co/auth/v1/token', () =>
        HttpResponse.json({
          access_token: 'at-abc',
          refresh_token: 'rt-abc',
          user: {
            id: 'user-1',
            email: 'reviewer@example.com',
            app_metadata: { tenant_id: 'tenant-1', role: 'reviewer' },
          },
          expires_in: 3600,
          token_type: 'bearer',
        }),
      ),
    )

    const { performLogin } = await vi.importActual<
      typeof import('~/routes/(auth)/login/-lib/login.server')
    >('~/routes/(auth)/login/-lib/login.server')

    const result = await performLogin({ email: 'reviewer@example.com', password: 'secret' })

    expect(result).toEqual({
      ok: true,
      user: { id: 'user-1', email: 'reviewer@example.com', tenantId: 'tenant-1', role: 'reviewer' },
    })
    expect(mockSetCookie).toHaveBeenCalledWith(
      'sb-access-token',
      'at-abc',
      expect.objectContaining({ httpOnly: true, maxAge: 3600 }),
    )
    expect(mockSetCookie).toHaveBeenCalledWith(
      'sb-refresh-token',
      'rt-abc',
      expect.objectContaining({ httpOnly: true, maxAge: 2592000 }),
    )
  })

  it('returns invalid_credentials without setting cookies on auth failure', async () => {
    server.use(
      http.post('https://test.supabase.co/auth/v1/token', () =>
        HttpResponse.json(
          { error: 'invalid_grant', message: 'Invalid login credentials' },
          { status: 400 },
        ),
      ),
    )

    const { performLogin } = await vi.importActual<
      typeof import('~/routes/(auth)/login/-lib/login.server')
    >('~/routes/(auth)/login/-lib/login.server')

    const result = await performLogin({ email: 'bad@example.com', password: 'wrong' })

    expect(result).toEqual({ ok: false, error: 'invalid_credentials' })
    expect(mockSetCookie).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// LoginForm component tests — loginFn mocked, navigation asserted
// ---------------------------------------------------------------------------

describe('LoginForm component', () => {
  beforeEach(async () => {
    loginFnMock.mockReset()
  })

  it('navigates to /inbox on successful login', async () => {
    loginFnMock.mockResolvedValueOnce({
      ok: true as const,
      user: { id: 'u1', email: 'rev@example.com', tenantId: 't1', role: 'reviewer' as const },
    })

    const { LoginForm } = await import('~/routes/(auth)/login/-components/LoginForm')
    render(<LoginForm />)

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'rev@example.com' } })
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'pass123' } })
    fireEvent.click(screen.getByRole('button', { name: /login/i }))

    await waitFor(() => {
      expect(loginFnMock).toHaveBeenCalledWith({
        data: { email: 'rev@example.com', password: 'pass123' },
      })
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/inbox' })
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('navigates to returnTo path when provided', async () => {
    loginFnMock.mockResolvedValueOnce({
      ok: true as const,
      user: { id: 'u1', email: 'rev@example.com', tenantId: 't1', role: 'reviewer' as const },
    })

    const { LoginForm } = await import('~/routes/(auth)/login/-components/LoginForm')
    render(<LoginForm returnTo="/threads/42" />)

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'rev@example.com' } })
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'pass123' } })
    fireEvent.click(screen.getByRole('button', { name: /login/i }))

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/threads/42' })
    })
  })

  it('shows error message on invalid credentials', async () => {
    loginFnMock.mockResolvedValueOnce({ ok: false as const, error: 'invalid_credentials' as const })

    const { LoginForm } = await import('~/routes/(auth)/login/-components/LoginForm')
    render(<LoginForm />)

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'bad@example.com' } })
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'wrongpass' } })
    fireEvent.click(screen.getByRole('button', { name: /login/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Invalid email or password')
    })
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})
