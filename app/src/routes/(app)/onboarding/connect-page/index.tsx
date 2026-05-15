import { createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import * as m from '~/paraglide/messages'
import { checkConnectedPagesFn } from './-lib/check-connected-pages.fn'
import { ConnectFacebookButton } from './-components/ConnectFacebookButton'
import { PageIdInput } from './-components/PageIdInput'
import { ConnectErrorPanel } from './-components/ConnectErrorPanel'

type FlowState = 'initial' | 'session_ready' | 'connecting' | 'error'

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
const FB_LOGIN_CONFIG_ID = (import.meta.env.VITE_FB_LOGIN_CONFIG_ID as string | undefined) ?? ''

function ConnectPageRoute() {
  const [state, setState] = useState<FlowState>('initial')
  const [error, setError] = useState<string | null>(null)

  function handleSessionReady() {
    setState('session_ready')
  }

  function handleError(err: string) {
    setError(err)
    setState('error')
  }

  function handleRetry() {
    setError(null)
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
            fbLoginConfigId={FB_LOGIN_CONFIG_ID}
            onSessionReady={handleSessionReady}
            onError={handleError}
          />
        )}

        {state === 'session_ready' && (
          <PageIdInput onError={handleError} onConnecting={() => setState('connecting')} />
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
