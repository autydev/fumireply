import { createServerFn } from '@tanstack/react-start'
import { getCookie, setCookie } from '@tanstack/react-start/server'
import { z } from 'zod'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { handleConnectPage } from './connect-page.server'

export type { ConnectPageResult } from './connect-page.server'

const Input = z.object({
  pageId: z.string().regex(/^\d+$/).min(5).max(20),
})

const SESSION_COOKIE = 'fb_connect_session'
const SESSION_COOKIE_ATTRS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
}

export const connectPageFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(Input)
  .handler(async ({ data, context }) => {
    const { tenantId } = context.user
    const encodedSession = getCookie(SESSION_COOKIE)

    const result = await handleConnectPage(tenantId, data.pageId, encodedSession)

    if (result.ok) {
      setCookie(SESSION_COOKIE, '', { ...SESSION_COOKIE_ATTRS, maxAge: 0 })
    }

    return result
  })
