import { useState } from 'react'
import { loadFbSdk } from '~/lib/facebook-sdk'
import { exchangeAndListFn, type ExchangeAndListResult } from '../-lib/exchange-and-list.fn'
import { m } from '~/paraglide/messages'

export type ConnectFacebookButtonPage = {
  id: string
  name: string
  pageAccessToken: string
}

export type ConnectFacebookButtonErrorCode =
  | 'consent_denied'
  | 'sdk_failed'
  | 'token_expired'
  | 'permission_missing'
  | 'no_pages'
  | 'rate_limited'
  | 'meta_unavailable'
  | 'internal_error'

type Props = {
  onSuccess: (pages: ConnectFacebookButtonPage[]) => void
  onError: (error: ConnectFacebookButtonErrorCode) => void
}

const FB_PERMISSIONS = [
  'pages_show_list',
  'pages_manage_metadata',
  'pages_read_engagement',
  'pages_messaging',
].join(',')

export function ConnectFacebookButton({ onSuccess, onError }: Props) {
  const [loading, setLoading] = useState(false)
  const appId = import.meta.env.VITE_FB_APP_ID as string | undefined

  async function handleClick() {
    if (loading) return
    if (!appId) {
      onError('sdk_failed')
      return
    }

    setLoading(true)
    try {
      const fb = await loadFbSdk(appId)

      const fbResponse = await new Promise<Parameters<Parameters<typeof fb.login>[0]>[0]>(
        (resolve) => {
          fb.login(resolve, {
            scope: FB_PERMISSIONS,
            auth_type: 'reauthenticate',
            return_scopes: true,
          })
        },
      )

      if (fbResponse.status !== 'connected' || !fbResponse.authResponse) {
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

      onSuccess(result.pages)
    } catch {
      onError('sdk_failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      aria-busy={loading}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        width: '100%',
        padding: '12px 16px',
        borderRadius: 9,
        border: 'none',
        background: '#1877F2',
        color: 'white',
        fontSize: 14,
        fontWeight: 600,
        cursor: loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.7 : 1,
        transition: 'opacity 120ms',
      }}
    >
      <svg
        aria-hidden="true"
        width={18}
        height={18}
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d="M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.49-3.89 3.78-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.45 2.89h-2.33v6.99A10 10 0 0 0 22 12Z" />
      </svg>
      {loading ? m.onboarding_connecting() : m.onboarding_connect_button()}
    </button>
  )
}
