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

const FB_LOAD_TIMEOUT_MS = 10_000

let loadPromise: Promise<void> | undefined

export function loadFbSdk(appId: string): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('FB SDK requires browser environment'))
  }
  if (loadPromise) return loadPromise

  loadPromise = new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        loadPromise = undefined
        reject(new Error('Facebook SDK load timeout'))
      }
    }, FB_LOAD_TIMEOUT_MS)

    window.fbAsyncInit = () => {
      settled = true
      clearTimeout(timer)
      window.FB.init({ appId, cookie: true, xfbml: false, version: 'v19.0' })
      resolve()
    }

    if (document.getElementById('facebook-jssdk')) {
      if (window.FB) {
        window.fbAsyncInit()
      }
      // Script tag exists but SDK hasn't initialised yet — fbAsyncInit above will fire
      // when it does; the shared timer handles the hang-forever case.
      return
    }

    const script = document.createElement('script')
    script.id = 'facebook-jssdk'
    script.src = 'https://connect.facebook.net/en_US/sdk.js'
    script.async = true
    script.defer = true
    script.onerror = () => {
      settled = true
      clearTimeout(timer)
      loadPromise = undefined
      reject(new Error('Failed to load Facebook SDK'))
    }

    // Prefer inserting before the first existing script; fall back to document.head
    // in case the page has no script tags at all.
    const firstScript = document.getElementsByTagName('script')[0]
    if (firstScript?.parentNode) {
      firstScript.parentNode.insertBefore(script, firstScript)
    } else {
      document.head.appendChild(script)
    }
  })

  return loadPromise
}
