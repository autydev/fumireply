import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'

const AUTH_REQUEST_TIMEOUT_MS = 5000

let supabaseInstance: SupabaseClient | null = null

const fetchWithTimeout: typeof fetch = (input, init) => {
  const signal = AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS)
  return fetch(input, { ...init, signal })
}

export function getSupabaseClient(): SupabaseClient {
  if (!supabaseInstance) {
    supabaseInstance = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_PUBLISHABLE_KEY!,
      { global: { fetch: fetchWithTimeout } },
    )
  }
  return supabaseInstance
}

export async function verifyAccessToken(token: string): Promise<User | null> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  return data.user
}

export async function refreshSession(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; user: User } | null> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken })
  if (error || !data.session || !data.user) return null
  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    user: data.user,
  }
}
