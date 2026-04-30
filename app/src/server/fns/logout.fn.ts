import { createServerFn } from '@tanstack/react-start'
import { getCookie, setCookie } from '@tanstack/react-start/server'
import { getSupabaseClient } from '~/server/services/auth'

const CLEARED_COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 0,
}

export async function performLogout(): Promise<{ ok: true }> {
  const accessToken = getCookie('sb-access-token')
  const refreshToken = getCookie('sb-refresh-token')

  if (accessToken && refreshToken) {
    try {
      const supabase = getSupabaseClient()
      await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
      await supabase.auth.signOut({ scope: 'global' })
    } catch {
      // best effort — always clear cookies below
    }
  }

  setCookie('sb-access-token', '', CLEARED_COOKIE_OPTS)
  setCookie('sb-refresh-token', '', CLEARED_COOKIE_OPTS)

  return { ok: true }
}

export const logoutFn = createServerFn({ method: 'POST' }).handler(performLogout)
