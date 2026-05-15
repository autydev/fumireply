import { useState, useEffect } from 'react'
import { getPageStatusFn } from '~/server/fns/page-status.fn'
import { m } from '~/paraglide/messages'

const POLL_INTERVAL_MS = 5 * 60 * 1000

export function TokenStatusBanner() {
  const [tokenValid, setTokenValid] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      try {
        const status = await getPageStatusFn()
        if (!cancelled) {
          setTokenValid(status.token_valid)
        }
      } catch {
        // Silently ignore auth errors and network errors
      }
    }

    poll()
    const id = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  if (tokenValid === false) {
    return (
      <div
        role="alert"
        style={{ backgroundColor: '#d32f2f', color: '#fff', padding: '8px 16px', textAlign: 'center' }}
      >
        {m.token_banner_invalid()}
      </div>
    )
  }

  return null
}
