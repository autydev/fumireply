export interface FBAuthResponse {
  accessToken: string
  userID: string
  expiresIn: number
  signedRequest: string
}

export type FBLoginStatus = 'connected' | 'not_authorized' | 'unknown'

export interface FBLoginResponse {
  status: FBLoginStatus
  authResponse: FBAuthResponse | null
}

export interface FBLoginOptions {
  scope?: string
  auth_type?: string
}

declare global {
  interface Window {
    FB: {
      login(cb: (response: FBLoginResponse) => void, opts?: FBLoginOptions): void
      init(params: { appId: string; cookie: boolean; xfbml: boolean; version: string }): void
    }
    fbAsyncInit?: () => void
  }
}

let loadPromise: Promise<void> | undefined

export function loadFbSdk(appId: string): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('FB SDK requires browser environment'))
  }
  if (loadPromise) return loadPromise

  loadPromise = new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB.init({ appId, cookie: true, xfbml: false, version: 'v19.0' })
      resolve()
    }

    if (document.getElementById('facebook-jssdk')) {
      if (window.FB) {
        window.fbAsyncInit()
      }
      // else: existing script will call fbAsyncInit once it finishes loading
      return
    }

    const script = document.createElement('script')
    script.id = 'facebook-jssdk'
    script.src = 'https://connect.facebook.net/en_US/sdk.js'
    script.async = true
    script.defer = true
    script.onerror = () => {
      loadPromise = undefined
      reject(new Error('Failed to load Facebook SDK'))
    }

    const firstScript = document.getElementsByTagName('script')[0]
    firstScript.parentNode?.insertBefore(script, firstScript)
  })

  return loadPromise
}
