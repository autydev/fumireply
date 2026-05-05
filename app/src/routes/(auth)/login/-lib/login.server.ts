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
  let authData: Awaited<
    ReturnType<ReturnType<typeof getSupabaseClient>['auth']['signInWithPassword']>
  >['data']

  try {
    const { data: d, error } = await getSupabaseClient().auth.signInWithPassword({
      email: data.email,
      password: data.password,
    })
    if (error || !d.session || !d.user) {
      console.warn('[login] signInWithPassword rejected', {
        email: data.email,
        supabaseError: error?.message,
        status: error?.status,
      })
      return { ok: false, error: 'invalid_credentials' }
    }
    authData = d
  } catch (err) {
    console.error('[login] signInWithPassword threw', {
      email: data.email,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : String(err),
    })
    return { ok: false, error: 'invalid_credentials' }
  }

  const { session, user } = authData

  const tenantId = user.app_metadata?.tenant_id as string | undefined
  if (!tenantId) {
    return { ok: false, error: 'invalid_credentials' }
  }

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
      tenantId,
      role,
    },
  }
}
