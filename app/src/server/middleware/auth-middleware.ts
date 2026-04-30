import { createMiddleware } from '@tanstack/react-start'
import { getCookie, setCookie } from '@tanstack/react-start/server'
import { redirect } from '@tanstack/react-router'
import { eq } from 'drizzle-orm'
import { dbAdmin } from '../db/client'
import { tenants } from '../db/schema'
import { verifyAccessToken, refreshSession } from '../services/auth'

export type AuthUser = {
  id: string
  email: string
  tenantId: string
  role: 'operator' | 'reviewer' | null
}

export const authMiddleware = createMiddleware({ type: 'function' }).server(
  async ({ next }) => {
    const accessToken = getCookie('sb-access-token')

    if (!accessToken) {
      throw redirect({ to: '/login' })
    }

    let user = await verifyAccessToken(accessToken)

    if (!user) {
      const refreshToken = getCookie('sb-refresh-token')
      if (!refreshToken) {
        throw redirect({ to: '/login' })
      }
      const refreshed = await refreshSession(refreshToken)
      if (!refreshed) {
        throw redirect({ to: '/login' })
      }
      setCookie('sb-access-token', refreshed.accessToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 3600,
      })
      setCookie('sb-refresh-token', refreshed.refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 2592000,
      })
      user = refreshed.user
    }

    const tenantId = (user.app_metadata?.tenant_id as string | undefined) ?? ''
    if (!tenantId) {
      throw redirect({ to: '/login?error=no_tenant' })
    }

    const tenantRows = await dbAdmin
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)

    const tenant = tenantRows[0]
    if (!tenant || tenant.status !== 'active') {
      throw redirect({ to: '/login?error=tenant_suspended' })
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
