import { useState } from 'react'
import * as m from '~/paraglide/messages'
import { connectPageFn, type ConnectPageResult } from '../-lib/connect-page.fn'
import { useRouter } from '@tanstack/react-router'

interface Props {
  onError: (error: string) => void
  onConnecting: () => void
}

const PAGE_ID_PATTERN = /^\d{5,20}$/

export function PageIdInput({ onError, onConnecting }: Props) {
  const [value, setValue] = useState('')
  const [touched, setTouched] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const router = useRouter()

  const trimmed = value.trim()
  const isValid = PAGE_ID_PATTERN.test(trimmed)
  const showError = touched && trimmed.length > 0 && !isValid

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (!isValid) return

    setConnecting(true)
    onConnecting()

    try {
      const result: ConnectPageResult = await connectPageFn({
        data: { pageId: trimmed },
      })

      if (!result.ok) {
        onError(result.error)
        return
      }

      await router.navigate({ to: '/inbox' })
    } catch {
      onError('internal_error')
    } finally {
      setConnecting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{m.onboarding_enter_page_id_heading()}</span>
        <input
          type="text"
          inputMode="numeric"
          pattern="\d*"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder={m.onboarding_page_id_placeholder()}
          disabled={connecting}
          style={{
            padding: '10px 14px',
            fontSize: 14,
            borderRadius: 8,
            border: `2px solid ${showError ? 'var(--color-danger, #d92d20)' : 'var(--color-line)'}`,
            background: 'transparent',
            color: 'inherit',
            outline: 'none',
          }}
        />
        <span style={{ fontSize: 12, color: 'var(--color-ink-3)' }}>{m.onboarding_page_id_help()}</span>
        {showError && (
          <span style={{ fontSize: 12, color: 'var(--color-danger, #d92d20)' }}>
            {m.onboarding_invalid_page_id()}
          </span>
        )}
      </label>
      <button
        type="submit"
        disabled={!isValid || connecting}
        style={{
          padding: '10px 20px',
          borderRadius: 8,
          background: 'var(--color-primary)',
          color: 'white',
          fontWeight: 600,
          fontSize: 14,
          border: 'none',
          cursor: !isValid || connecting ? 'not-allowed' : 'pointer',
          opacity: !isValid || connecting ? 0.6 : 1,
          alignSelf: 'flex-start',
        }}
      >
        {connecting ? m.onboarding_connecting() : m.onboarding_connect_button()}
      </button>
    </form>
  )
}
