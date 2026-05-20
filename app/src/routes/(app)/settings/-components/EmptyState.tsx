import { Link } from '@tanstack/react-router'
import { m } from '~/paraglide/messages'

export function EmptyState() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: '48px 24px',
        color: 'var(--color-ink-3)',
        textAlign: 'center',
      }}
    >
      <p style={{ fontSize: 14, margin: 0 }}>{m.settings_no_pages_empty()}</p>
      <Link
        to="/onboarding/connect-page"
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--color-primary)',
          textDecoration: 'none',
          padding: '6px 14px',
          borderRadius: 8,
          border: '1px solid var(--color-primary)',
          transition: 'background 120ms',
        }}
      >
        {m.settings_no_pages_cta()}
      </Link>
    </div>
  )
}
