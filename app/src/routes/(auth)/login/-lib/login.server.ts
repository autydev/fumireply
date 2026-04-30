import { setCookie } from '@tanstack/react-start/server'
import { getSupabaseClient } from '~/server/services/auth'

export type LoginResult =
  | {
      ok: true
      user: {
        id: string
        email: string
        tenantId: string
        role: 'operator' | 'reviewer' | null
      }
    }
  | { ok: false; error: 'invalid_credentials' }

export async function performLogin(data: {
  email: string
  password: string
}): Promise<LoginResult> {
  const supabase = getSupabaseClient()
  const { data: authData, error } = await supabase.auth.signInWithPassword({
    email: data.email,
    password: data.password,
  })

  if (error || !authData.session || !authData.user) {
    return { ok: false, error: 'invalid_credentials' }
  }

  const { session, user } = authData

  setCookie('sb-access-token', session.access_token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 3600,
  })
  setCookie('sb-refresh-token', session.refresh_token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 2592000,
  })

  const rawRole = user.app_metadata?.role as string | undefined
  const role: 'operator' | 'reviewer' | null =
    rawRole === 'operator' || rawRole === 'reviewer' ? rawRole : null

  return {
    ok: true,
    user: {
      id: user.id,
      email: user.email ?? '',
      tenantId: (user.app_metadata?.tenant_id as string | undefined) ?? '',
      role,
    },
  }
}
