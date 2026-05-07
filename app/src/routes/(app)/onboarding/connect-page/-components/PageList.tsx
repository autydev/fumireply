import { useState } from 'react'
import * as m from '~/paraglide/messages'
import { connectPageFn, type ConnectPageResult } from '../-lib/connect-page.fn'
import { useRouter } from '@tanstack/react-router'

interface Page {
  id: string
  name: string
}

interface Props {
  pages: Page[]
  onError: (error: string) => void
  onConnecting: () => void
}

export function PageList({ pages, onError, onConnecting }: Props) {
  const [selected, setSelected] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const router = useRouter()

  async function handleConnect() {
    if (!selected) return
    const page = pages.find((p) => p.id === selected)
    if (!page) return

    setConnecting(true)
    onConnecting()

    try {
      const result: ConnectPageResult = await connectPageFn({
        data: {
          pageId: page.id,
          pageName: page.name,
        },
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{m.onboarding_select_page_heading()}</p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {pages.map((page) => (
          <li key={page.id}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 14px',
                borderRadius: 8,
                border: `2px solid ${selected === page.id ? 'var(--color-primary)' : 'var(--color-line)'}`,
                cursor: 'pointer',
                background: selected === page.id ? 'var(--color-bg-hover)' : 'transparent',
              }}
            >
              <input
                type="radio"
                name="selected-page"
                value={page.id}
                checked={selected === page.id}
                onChange={() => setSelected(page.id)}
              />
              <span style={{ fontSize: 14, fontWeight: 500 }}>{page.name}</span>
              <span style={{ fontSize: 12, color: 'var(--color-ink-3)', marginLeft: 'auto' }}>
                ID: {page.id}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={handleConnect}
        disabled={!selected || connecting}
        style={{
          padding: '10px 20px',
          borderRadius: 8,
          background: 'var(--color-primary)',
          color: 'white',
          fontWeight: 600,
          fontSize: 14,
          border: 'none',
          cursor: !selected || connecting ? 'not-allowed' : 'pointer',
          opacity: !selected || connecting ? 0.6 : 1,
          alignSelf: 'flex-start',
        }}
      >
        {connecting ? m.onboarding_connecting() : m.onboarding_connect_button()}
      </button>
    </div>
  )
}
