import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { withTenant } from '~/server/db/with-tenant'
import { handleConnectPage, type ConnectPageResult } from './connect-page.server'

export type { ConnectPageResult } from './connect-page.server'

const inputSchema = z.object({
  pageId: z
    .string()
    .regex(/^\d+$/)
    .min(5)
    .max(20),
  pageName: z.string().min(1).max(200),
  pageAccessToken: z.string().min(20).max(2000),
})

export const connectPageFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(inputSchema)
  .handler(async ({ data, context }): Promise<ConnectPageResult> => {
    const tenantId = context.user.tenantId
    return withTenant(tenantId, async (tx) => {
      return handleConnectPage(tx, tenantId, data)
    })
  })
