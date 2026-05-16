import { setCookie } from '@tanstack/react-start/server'
import { env } from '~/server/env'
import { getSsmParameter } from '~/server/services/ssm'
import { exchangeUserToken } from '~/server/services/facebook'
import { encryptToken, getMasterKey } from '~/server/services/crypto'

export const SESSION_COOKIE = 'fb_connect_session'

export type ExchangeAndListResult =
  | { ok: true }
  | { ok: false; error: 'token_expired' | 'permission_missing' | 'rate_limited' | 'meta_unavailable' | 'internal_error'; message: string }

// Server-only. Exchanges the short-lived user token for a long-lived user token,
// encrypts it, and parks it in a short-lived HttpOnly cookie. The page list and
// tokens are never returned to the browser. Lives in a .server.ts module so the
// server-only imports are excluded from the client bundle (same convention as
// send-reply.server.ts). Tests import this directly.
export async function performExchangeAndList(
  data: { shortLivedUserToken: string },
): Promise<ExchangeAndListResult> {
  try {
    const appSecret = await getSsmParameter(env.META_APP_SECRET_SSM_KEY)
    const { accessToken: longToken } = await exchangeUserToken(
      data.shortLivedUserToken,
      env.META_APP_ID,
      appSecret,
    )

    const masterKey = await getMasterKey()
    const encryptedLongToken = encryptToken(longToken, masterKey)
    setCookie(SESSION_COOKIE, encryptedLongToken.toString('base64'), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 600, // 10 minutes — long enough for the user to paste a page id
    })

    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    if (msg === 'token_expired') return { ok: false, error: 'token_expired', message: 'Token expired.' }
    if (msg === 'permission_missing') return { ok: false, error: 'permission_missing', message: 'Missing pages_show_list permission.' }
    if (msg === 'rate_limited') return { ok: false, error: 'rate_limited', message: 'Rate limited. Please wait.' }
    if (msg === 'meta_unavailable') return { ok: false, error: 'meta_unavailable', message: 'Facebook API unavailable.' }
    return { ok: false, error: 'internal_error', message: 'Internal error.' }
  }
}
