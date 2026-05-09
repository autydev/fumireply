import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { handleConnectPage } from './connect-page.server'

const Input = z.object({
  pageId: z.string().regex(/^\d+$/).min(5).max(20),
})

export type ConnectPageResult =
  | { ok: true; pageId: string; pageName: string }
  | { ok: false; error: 'already_connected' | 'subscribe_failed' | 'token_invalid' | 'permission_missing' | 'webhook_url_failed' | 'encryption_failed' | 'db_failed' | 'meta_unavailable' | 'rate_limited' | 'internal_error'; message: string }

export const connectPageFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(Input)
  .handler(async ({ data, context }): Promise<ConnectPageResult> => {
    return handleConnectPage(context.user.tenantId, data.pageId)
  })
