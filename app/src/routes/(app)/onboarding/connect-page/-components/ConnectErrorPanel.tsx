import * as m from '~/paraglide/messages'

const ERROR_MESSAGES: Record<string, () => string> = {
  token_expired: m.onboarding_error_token_expired,
  permission_missing: m.onboarding_error_permission_missing,
  subscribe_failed: m.onboarding_error_subscribe_failed,
  consent_denied: m.onboarding_consent_denied,
  no_pages: m.onboarding_no_pages,
  internal_error: m.onboarding_error_generic,
  meta_unavailable: m.onboarding_error_generic,
  rate_limited: m.onboarding_error_generic,
  already_connected: m.onboarding_already_connected,
  token_invalid: m.onboarding_error_token_expired,
  webhook_url_failed: m.onboarding_error_subscribe_failed,
  encryption_failed: m.onboarding_error_generic,
  db_failed: m.onboarding_error_generic,
}

interface Props {
  error: string
  onRetry: () => void
}

export function ConnectErrorPanel({ error, onRetry }: Props) {
  const getMessage = ERROR_MESSAGES[error] ?? m.onboarding_error_generic
  const message = getMessage()

  return (
    <div
      role="alert"
      style={{
        padding: '14px 18px',
        borderRadius: 8,
        background: 'var(--color-red-bg, #fff0f0)',
        border: '1px solid var(--color-red, #e53e3e)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <p style={{ margin: 0, fontSize: 14, color: 'var(--color-red, #e53e3e)' }}>{message}</p>
      <button
        type="button"
        onClick={onRetry}
        style={{
          alignSelf: 'flex-start',
          padding: '6px 14px',
          borderRadius: 6,
          border: '1px solid var(--color-red, #e53e3e)',
          background: 'transparent',
          color: 'var(--color-red, #e53e3e)',
          fontSize: 13,
          fontWeight: 500,
          cursor: 'pointer',
        }}
      >
        {m.onboarding_retry_button()}
      </button>
    </div>
  )
}
