import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { loginFn } from '../-lib/login.fn'
import { m } from '~/paraglide/messages'

export function LoginForm({ returnTo }: { returnTo?: string }) {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const result = await loginFn({ data: { email, password } })
      if (result.ok) {
        await navigate({ to: returnTo ?? '/inbox' })
      } else {
        setError(m.login_error_invalid_credentials())
      }
    } catch {
      setError('Login failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const inputStyle = {
    width: '100%',
    padding: '10px 12px',
    border: '1px solid var(--color-line)',
    borderRadius: 9,
    background: 'var(--color-bg-sunken)',
    fontSize: '13.5px',
    outline: 'none',
    transition: 'border-color 120ms, background 120ms, box-shadow 120ms',
    display: 'block',
  } as const

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: `
          radial-gradient(800px 500px at 20% 10%, oklch(0.55 0.16 265 / 0.08), transparent),
          radial-gradient(600px 400px at 90% 80%, oklch(0.62 0.17 305 / 0.06), transparent),
          var(--color-bg)
        `,
        padding: '40px 20px',
      }}
    >
      <div
        style={{
          background: 'var(--color-bg-raised)',
          border: '1px solid var(--color-line)',
          borderRadius: 20,
          padding: '36px 36px 32px',
          boxShadow: 'var(--shadow-lg)',
          width: '100%',
          maxWidth: 400,
        }}
      >
        {/* Brand mark */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-violet) 100%)',
              display: 'grid',
              placeItems: 'center',
              color: 'white',
              fontWeight: 800,
              fontSize: 20,
              letterSpacing: '-0.02em',
              boxShadow: 'var(--shadow-md), inset 0 1px 0 rgba(255,255,255,0.25)',
            }}
          >
            F
          </div>
        </div>

        <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', textAlign: 'center', marginBottom: 6 }}>
          Fumireply
        </div>
        <div style={{ fontSize: 13, color: 'var(--color-ink-3)', textAlign: 'center', marginBottom: 26 }}>
          Messenger + Instagram DM を半自動で。
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 12 }}>
            <label
              htmlFor="login-email"
              style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--color-ink-2)', marginBottom: 5, letterSpacing: '0.03em' }}
            >
              {m.login_email_label()}
            </label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              style={inputStyle}
              onFocus={(e) => {
                e.target.style.borderColor = 'var(--color-primary)'
                e.target.style.background = 'white'
                e.target.style.boxShadow = '0 0 0 3px oklch(0.55 0.16 265 / 0.1)'
              }}
              onBlur={(e) => {
                e.target.style.borderColor = 'var(--color-line)'
                e.target.style.background = 'var(--color-bg-sunken)'
                e.target.style.boxShadow = 'none'
              }}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label
              htmlFor="login-password"
              style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--color-ink-2)', marginBottom: 5, letterSpacing: '0.03em' }}
            >
              {m.login_password_label()}
            </label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              style={inputStyle}
              onFocus={(e) => {
                e.target.style.borderColor = 'var(--color-primary)'
                e.target.style.background = 'white'
                e.target.style.boxShadow = '0 0 0 3px oklch(0.55 0.16 265 / 0.1)'
              }}
              onBlur={(e) => {
                e.target.style.borderColor = 'var(--color-line)'
                e.target.style.background = 'var(--color-bg-sunken)'
                e.target.style.boxShadow = 'none'
              }}
            />
          </div>

          {error && (
            <p
              role="alert"
              style={{
                fontSize: 12,
                color: 'var(--color-rose-ink)',
                background: 'var(--color-rose-soft)',
                border: '1px solid oklch(0.65 0.18 20 / 0.25)',
                borderRadius: 7,
                padding: '8px 12px',
                margin: '8px 0',
              }}
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: 11,
              borderRadius: 9,
              background: 'var(--color-ink)',
              color: 'white',
              fontWeight: 600,
              fontSize: '13.5px',
              marginTop: 8,
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.7 : 1,
              transition: 'opacity 120ms',
            }}
          >
            {loading ? 'Logging in…' : m.login_submit_button()}
          </button>
        </form>

        <div
          style={{
            textAlign: 'center',
            fontSize: 11,
            color: 'var(--color-ink-3)',
            marginTop: 18,
            fontFamily: 'var(--font-mono)',
          }}
        >
          Supabase Auth
        </div>
      </div>
    </div>
  )
}
