import { useState } from 'react'
import { connectPageFn, type ConnectPageResult } from '../-lib/connect-page.fn'
import { m } from '~/paraglide/messages'
import type { ConnectFacebookButtonPage } from './ConnectFacebookButton'

export type PageListErrorCode =
  | 'already_connected'
  | 'subscribe_failed'
  | 'token_invalid'
  | 'permission_missing'
  | 'webhook_url_failed'
  | 'encryption_failed'
  | 'db_failed'
  | 'meta_unavailable'
  | 'internal_error'

type Props = {
  pages: ConnectFacebookButtonPage[]
  onSuccess: (page: { pageId: string; pageName: string }) => void
  onError: (error: PageListErrorCode) => void
}

export function PageList({ pages, onSuccess, onError }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(pages[0]?.id ?? null)
  const [submitting, setSubmitting] = useState(false)

  async function handleConfirm() {
    if (submitting || !selectedId) return
    const target = pages.find((p) => p.id === selectedId)
    if (!target) return

    setSubmitting(true)
    try {
      const result: ConnectPageResult = await connectPageFn({
        data: {
          pageId: target.id,
          pageName: target.name,
          pageAccessToken: target.pageAccessToken,
        },
      })

      if (!result.ok) {
        onError(result.error)
        return
      }

      onSuccess({ pageId: result.pageId, pageName: result.pageName })
    } catch {
      onError('internal_error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <h2
        style={{
          fontSize: 14,
          fontWeight: 700,
          letterSpacing: '-0.01em',
          marginBottom: 12,
        }}
      >
        {m.onboarding_select_page_heading()}
      </h2>

      <div
        role="radiogroup"
        aria-label={m.onboarding_select_page_heading()}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          marginBottom: 16,
        }}
      >
        {pages.map((page) => {
          const active = page.id === selectedId
          return (
            <button
              key={page.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setSelectedId(page.id)}
              disabled={submitting}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 2,
                padding: '12px 14px',
                borderRadius: 9,
                border: `1px solid ${active ? 'var(--color-primary)' : 'var(--color-line)'}`,
                background: active ? 'oklch(0.55 0.16 265 / 0.06)' : 'var(--color-bg-raised)',
                cursor: submitting ? 'not-allowed' : 'pointer',
                textAlign: 'left',
                transition: 'border-color 120ms, background 120ms',
              }}
            >
              <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--color-ink)' }}>
                {page.name}
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--color-ink-3)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                ID: {page.id}
              </span>
            </button>
          )
        })}
      </div>

      <button
        type="button"
        onClick={handleConfirm}
        disabled={submitting || !selectedId}
        aria-busy={submitting}
        style={{
          width: '100%',
          padding: 11,
          borderRadius: 9,
          background: 'var(--color-ink)',
          color: 'white',
          fontWeight: 600,
          fontSize: 13.5,
          border: 'none',
          cursor: submitting || !selectedId ? 'not-allowed' : 'pointer',
          opacity: submitting || !selectedId ? 0.7 : 1,
          transition: 'opacity 120ms',
        }}
      >
        {submitting ? m.onboarding_connecting() : m.onboarding_connect_button()}
      </button>
    </div>
  )
}
