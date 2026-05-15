import { useState } from 'react'
import * as m from '~/paraglide/messages'
import { loadFbSdk } from '~/lib/facebook-sdk'
import { exchangeAndListFn, type ExchangeAndListResult } from '../-lib/exchange-and-list.fn'

interface Props {
  fbAppId: string
  fbLoginConfigId: string
  onSessionReady: () => void
  onError: (error: string) => void
}

export function ConnectFacebookButton({ fbAppId, fbLoginConfigId, onSessionReady, onError }: Props) {
  const [loading, setLoading] = useState(false)

  async function handleConnect() {
    setLoading(true)
    try {
      const fb = await loadFbSdk(fbAppId)

      const fbResponse = await new Promise<{ status: string; authResponse: { accessToken: string } | null }>(
        (resolve) => {
          fb.login((res) => resolve(res as never), {
            config_id: fbLoginConfigId,
            auth_type: 'reauthenticate',
          })
        },
      )

      if (!fbResponse.authResponse) {
        onError('consent_denied')
        return
      }

      const result: ExchangeAndListResult = await exchangeAndListFn({
        data: { shortLivedUserToken: fbResponse.authResponse.accessToken },
      })

      if (!result.ok) {
        onError(result.error)
        return
      }

      onSessionReady()
    } catch {
      onError('internal_error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      type="button"
      onClick={handleConnect}
      disabled={loading}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 20px',
        borderRadius: 8,
        background: '#1877f2',
        color: 'white',
        fontWeight: 600,
        fontSize: 15,
        border: 'none',
        cursor: loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.7 : 1,
        transition: 'opacity 150ms',
      }}
    >
      {loading ? m.onboarding_connecting() : m.onboarding_connect_button()}
    </button>
  )
}
