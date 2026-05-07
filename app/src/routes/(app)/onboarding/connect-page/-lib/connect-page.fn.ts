import { createServerFn } from '@tanstack/react-start'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { connectedPages } from '~/server/db/schema'
import { withTenant } from '~/server/db/with-tenant'
import { encryptToken, getMasterKey } from '~/server/services/crypto'
import { subscribePageWebhook } from '~/server/services/facebook'
import { env } from '~/server/env'

const Input = z.object({
  pageId: z.string().regex(/^\d+$/).min(5).max(20),
  pageName: z.string().min(1).max(200),
  pageAccessToken: z.string().min(20).max(2000),
})

export type ConnectPageResult =
  | { ok: true; pageId: string; pageName: string }
  | { ok: false; error: 'already_connected' | 'subscribe_failed' | 'token_invalid' | 'permission_missing' | 'webhook_url_failed' | 'encryption_failed' | 'db_failed' | 'meta_unavailable' | 'internal_error'; message: string }

export const connectPageFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(Input)
  .handler(async ({ data, context }): Promise<ConnectPageResult> => {
    const { tenantId } = context.user

    try {
      const existing = await withTenant(tenantId, async (tx) => {
        return tx
          .select({ id: connectedPages.id })
          .from(connectedPages)
          .where(eq(connectedPages.tenantId, tenantId))
          .limit(1)
      })

      if (existing.length > 0) {
        return { ok: false, error: 'already_connected', message: 'Page already connected.' }
      }
    } catch {
      return { ok: false, error: 'db_failed', message: 'DB check failed.' }
    }

    try {
      await subscribePageWebhook(data.pageId, data.pageAccessToken)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown'
      if (msg === 'token_invalid') return { ok: false, error: 'token_invalid', message: 'Invalid page access token.' }
      if (msg === 'permission_missing') return { ok: false, error: 'permission_missing', message: 'Missing pages_manage_metadata.' }
      if (msg === 'webhook_url_failed') return { ok: false, error: 'webhook_url_failed', message: 'Webhook URL verification failed.' }
      return { ok: false, error: 'subscribe_failed', message: 'Subscribe failed.' }
    }

    let encryptedToken: Buffer
    try {
      const masterKey = await getMasterKey()
      encryptedToken = encryptToken(data.pageAccessToken, masterKey)
    } catch {
      return { ok: false, error: 'encryption_failed', message: 'Encryption failed.' }
    }

    try {
      await withTenant(tenantId, async (tx) => {
        await tx
          .insert(connectedPages)
          .values({
            tenantId,
            pageId: data.pageId,
            pageName: data.pageName,
            pageAccessTokenEncrypted: encryptedToken,
            webhookVerifyTokenSsmKey: env.WEBHOOK_VERIFY_TOKEN_SSM_KEY,
          })
          .onConflictDoUpdate({
            target: connectedPages.tenantId,
            set: {
              pageId: data.pageId,
              pageName: data.pageName,
              pageAccessTokenEncrypted: encryptedToken,
            },
          })
      })
    } catch {
      return { ok: false, error: 'db_failed', message: 'DB upsert failed.' }
    }

    return { ok: true, pageId: data.pageId, pageName: data.pageName }
  })
