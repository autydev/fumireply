declare global {
  interface Window {
    FB?: FbSdk
    fbAsyncInit?: () => void
  }
}

export type FbAuthResponse = {
  accessToken: string
  userID: string
  expiresIn: number
  signedRequest: string
  graphDomain?: string
  data_access_expiration_time?: number
}

export type FbLoginResponse = {
  status: 'connected' | 'not_authorized' | 'unknown'
  authResponse: FbAuthResponse | null
}

export type FbLoginOptions = {
  scope?: string
  config_id?: string
  auth_type?: 'rerequest' | 'reauthenticate' | 'reauthorize'
  return_scopes?: boolean
}

export type FbSdk = {
  init: (options: { appId: string; version: string; cookie?: boolean; xfbml?: boolean }) => void
  login: (callback: (response: FbLoginResponse) => void, options?: FbLoginOptions) => void
  logout: (callback: (response: unknown) => void) => void
  getLoginStatus: (callback: (response: FbLoginResponse) => void) => void
}

const SDK_VERSION = 'v19.0'
const SDK_SRC = 'https://connect.facebook.net/en_US/sdk.js'

let loaderPromise: Promise<FbSdk> | null = null

export function loadFbSdk(appId: string): Promise<FbSdk> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('loadFbSdk can only run in the browser'))
  }
  if (loaderPromise) return loaderPromise

  loaderPromise = new Promise<FbSdk>((resolve, reject) => {
    if (window.FB) {
      window.FB.init({ appId, version: SDK_VERSION, cookie: false, xfbml: false })
      resolve(window.FB)
      return
    }

    const existing = document.getElementById('facebook-jssdk') as HTMLScriptElement | null
    if (existing) {
      const onReady = () => {
        if (window.FB) {
          window.FB.init({ appId, version: SDK_VERSION, cookie: false, xfbml: false })
          resolve(window.FB)
        } else {
          reject(new Error('FB SDK script loaded but window.FB is missing'))
        }
      }
      existing.addEventListener('load', onReady, { once: true })
      existing.addEventListener('error', () => reject(new Error('FB SDK script failed to load')), {
        once: true,
      })
      return
    }

    window.fbAsyncInit = () => {
      if (!window.FB) {
        reject(new Error('fbAsyncInit fired but window.FB is missing'))
        return
      }
      window.FB.init({ appId, version: SDK_VERSION, cookie: false, xfbml: false })
      resolve(window.FB)
    }

    const script = document.createElement('script')
    script.id = 'facebook-jssdk'
    script.async = true
    script.defer = true
    script.crossOrigin = 'anonymous'
    script.src = SDK_SRC
    script.onerror = () => {
      loaderPromise = null
      reject(new Error('FB SDK script failed to load'))
    }
    document.head.appendChild(script)
  })

  return loaderPromise
}

export function _resetFbSdkLoaderForTests(): void {
  loaderPromise = null
}
