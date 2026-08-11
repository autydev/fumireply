import { createMiddleware } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { redirect } from '@tanstack/react-router'
import { eq } from 'drizzle-orm'
import { dbAdmin } from '../db/client'
import { tenants } from '../db/schema'
import { verifyAccessToken, refreshSession } from '../services/auth'
import { ACCESS_COOKIE, REFRESH_COOKIE, setAuthCookies } from '../services/auth-cookies'

export type AuthUser = {
  id: string
  email: string
  tenantId: string
  role: 'operator' | 'reviewer' | null
}

export const authMiddleware = createMiddleware({ type: 'function' }).server(
  async ({ next }) => {
    // access Cookie は maxAge=30日で保持するが、JWT 本体は Supabase 側で短命(既定1h)。
    // access Cookie が無い（=消えた）だけでは即ログアウトせず、refresh Cookie があれば
    // リフレッシュで復帰を試みる。ここで即 /login に飛ばしていたのが「1時間ごとログアウト」の主因だった。
    const accessToken = getCookie(ACCESS_COOKIE)
    let user = accessToken ? await verifyAccessToken(accessToken) : null

    if (!user) {
      const refreshToken = getCookie(REFRESH_COOKIE)
      if (!refreshToken) {
        throw redirect({ to: '/login', search: { returnTo: undefined, error: undefined } })
      }
      const refreshed = await refreshSession(refreshToken)
      if (!refreshed) {
        throw redirect({ to: '/login', search: { returnTo: undefined, error: undefined } })
      }
      setAuthCookies(refreshed.accessToken, refreshed.refreshToken)
      user = refreshed.user
    }

    const tenantId = (user.app_metadata?.tenant_id as string | undefined) ?? ''
    if (!tenantId) {
      throw redirect({ to: '/login', search: { returnTo: undefined, error: 'no_tenant' } })
    }

    const tenantRows = await dbAdmin
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)

    const tenant = tenantRows[0]
    if (!tenant || tenant.status !== 'active') {
      throw redirect({ to: '/login', search: { returnTo: undefined, error: 'tenant_suspended' } })
    }

    const rawRole = user.app_metadata?.role as string | undefined
    const role: AuthUser['role'] =
      rawRole === 'operator' || rawRole === 'reviewer' ? rawRole : null

    return next({
      context: {
        user: {
          id: user.id,
          email: user.email ?? '',
          tenantId,
          role,
        } satisfies AuthUser,
      },
    })
  },
)
