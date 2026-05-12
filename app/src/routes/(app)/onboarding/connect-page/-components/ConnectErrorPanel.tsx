import { m } from '~/paraglide/messages'
import type { ConnectFacebookButtonErrorCode } from './ConnectFacebookButton'
import type { PageListErrorCode } from './PageList'

export type ConnectErrorCode = ConnectFacebookButtonErrorCode | PageListErrorCode

type Props = {
  error: ConnectErrorCode
  onRetry: () => void
}

function getErrorMessage(error: ConnectErrorCode): string {
  switch (error) {
    case 'consent_denied':
      return m.onboarding_consent_denied()
    case 'token_expired':
    case 'token_invalid':
      return m.onboarding_error_token_expired()
    case 'permission_missing':
      return m.onboarding_error_permission_missing()
    case 'no_pages':
      return m.onboarding_no_pages()
    case 'subscribe_failed':
    case 'webhook_url_failed':
      return m.onboarding_error_subscribe_failed()
    default:
      return m.onboarding_error_generic()
  }
}

export function ConnectErrorPanel({ error, onRetry }: Props) {
  const message = getErrorMessage(error)

  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '14px 16px',
        borderRadius: 9,
        border: '1px solid oklch(0.65 0.18 20 / 0.25)',
        background: 'var(--color-rose-soft)',
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: 13,
          color: 'var(--color-rose-ink)',
          lineHeight: 1.5,
        }}
      >
        {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        style={{
          alignSelf: 'flex-start',
          padding: '8px 14px',
          borderRadius: 7,
          border: '1px solid var(--color-rose-ink)',
          background: 'transparent',
          color: 'var(--color-rose-ink)',
          fontSize: 12.5,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        {m.onboarding_retry_button()}
      </button>
    </div>
  )
}
