import { createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import * as m from '~/paraglide/messages'
import { checkConnectedPagesFn } from './-lib/check-connected-pages.fn'
import { ConnectFacebookButton } from './-components/ConnectFacebookButton'
import { PageList } from './-components/PageList'
import { ConnectErrorPanel } from './-components/ConnectErrorPanel'

type FlowState = 'initial' | 'pages_loaded' | 'connecting' | 'error'

export const Route = createFileRoute('/(app)/onboarding/connect-page/')({
  beforeLoad: async () => {
    const { count } = await checkConnectedPagesFn()
    if (count > 0) {
      throw redirect({ to: '/inbox' })
    }
  },
  component: ConnectPageRoute,
})

const FB_APP_ID = (import.meta.env.VITE_FB_APP_ID as string | undefined) ?? ''

function ConnectPageRoute() {
  const [state, setState] = useState<FlowState>('initial')
  const [pages, setPages] = useState<Array<{ id: string; name: string }>>([])
  const [error, setError] = useState<string | null>(null)

  function handlePagesLoaded(loaded: typeof pages) {
    setPages(loaded)
    setState('pages_loaded')
  }

  function handleError(err: string) {
    setError(err)
    setState('error')
  }

  function handleRetry() {
    setError(null)
    setPages([])
    setState('initial')
  }

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
      }}
    >
      <div
        style={{
          maxWidth: 480,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{m.onboarding_title()}</h1>
          <p style={{ fontSize: 14, color: 'var(--color-ink-2)', margin: 0 }}>{m.onboarding_description()}</p>
        </div>

        {state === 'initial' && (
          <ConnectFacebookButton
            fbAppId={FB_APP_ID}
            onPagesLoaded={handlePagesLoaded}
            onError={handleError}
          />
        )}

        {state === 'pages_loaded' && (
          <PageList
            pages={pages}
            onError={handleError}
            onConnecting={() => setState('connecting')}
          />
        )}

        {state === 'connecting' && (
          <p style={{ fontSize: 14, color: 'var(--color-ink-2)' }}>{m.onboarding_connecting()}</p>
        )}

        {state === 'error' && error && (
          <ConnectErrorPanel error={error} onRetry={handleRetry} />
        )}
      </div>
    </div>
  )
}
