import { createServerFn } from '@tanstack/react-start'
import { getCookie, setCookie } from '@tanstack/react-start/server'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { connectedPages } from '~/server/db/schema'
import { withTenant } from '~/server/db/with-tenant'
import { decryptToken, encryptToken, getMasterKey } from '~/server/services/crypto'
import { fetchPageWithToken, subscribePageWebhook } from '~/server/services/facebook'
import { env } from '~/server/env'
import {
  SESSION_COOKIE,
  SESSION_COOKIE_ATTRS,
  type ConnectPageResult,
} from './connect-page.server'

export type { ConnectPageResult } from './connect-page.server'

const Input = z.object({
  pageId: z.string().regex(/^\d+$/).min(5).max(20),
})

export const connectPageFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(Input)
  .handler(async ({ data, context }): Promise<ConnectPageResult> => {
    const { tenantId } = context.user

    // Guard: tenant already has an active page connected
    try {
      const activeExisting = await withTenant(tenantId, async (tx) => {
        return tx
          .select({ id: connectedPages.id })
          .from(connectedPages)
          .where(and(eq(connectedPages.tenantId, tenantId), eq(connectedPages.isActive, true)))
          .limit(1)
      })
      if (activeExisting.length > 0) {
        return { ok: false, error: 'already_connected', message: 'Page already connected.' }
      }
    } catch {
      return { ok: false, error: 'db_failed', message: 'DB check failed.' }
    }

    // Retrieve the long user token stored server-side by exchangeAndListFn.
    // The page access token never travels through the browser.
    const encodedSession = getCookie(SESSION_COOKIE)
    if (!encodedSession) {
      return { ok: false, error: 'token_invalid', message: 'Session expired. Please reconnect.' }
    }

    let pageAccessToken: string
    let pageName: string
    try {
      const masterKey = await getMasterKey()
      const longToken = decryptToken(Buffer.from(encodedSession, 'base64'), masterKey)
      // Direct page fetch — works for both personal-owned and Business-owned pages.
      // Server fetches the canonical name + access_token so the browser cannot spoof either.
      const page = await fetchPageWithToken(data.pageId, longToken)
      pageAccessToken = page.pageAccessToken
      pageName = page.name
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown'
      if (msg === 'page_not_found') return { ok: false, error: 'token_invalid', message: 'Page not found or you do not have access.' }
      if (msg === 'token_expired') return { ok: false, error: 'token_invalid', message: 'Session expired. Please reconnect.' }
      if (msg === 'permission_missing') return { ok: false, error: 'permission_missing', message: 'Missing pages_show_list permission.' }
      if (msg === 'rate_limited') return { ok: false, error: 'rate_limited', message: 'Rate limited. Please wait.' }
      if (msg === 'meta_unavailable') return { ok: false, error: 'meta_unavailable', message: 'Facebook API unavailable.' }
      return { ok: false, error: 'internal_error', message: 'Failed to retrieve page token.' }
    }

    try {
      await subscribePageWebhook(data.pageId, pageAccessToken)
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
      encryptedToken = encryptToken(pageAccessToken, masterKey)
    } catch {
      return { ok: false, error: 'encryption_failed', message: 'Encryption failed.' }
    }

    try {
      await withTenant(tenantId, async (tx) => {
        // Check if this tenant already has a row for this specific pageId (possibly inactive).
        // If so, UPDATE it (re-connect / token refresh) rather than INSERT to avoid
        // triggering the global pageId unique constraint with an onConflictDoUpdate that
        // could otherwise overwrite another tenant's row.
        const existing = await tx
          .select({ id: connectedPages.id })
          .from(connectedPages)
          .where(and(eq(connectedPages.tenantId, tenantId), eq(connectedPages.pageId, data.pageId)))
          .limit(1)

        const rowValues = {
          pageName,
          pageAccessTokenEncrypted: encryptedToken,
          webhookVerifyTokenSsmKey: env.WEBHOOK_VERIFY_TOKEN_SSM_KEY,
          isActive: true,
        }

        if (existing.length > 0) {
          await tx.update(connectedPages).set(rowValues).where(eq(connectedPages.id, existing[0].id))
        } else {
          // Plain INSERT — if another tenant owns this pageId the unique constraint fires
          // and we surface it as already_connected rather than updating their row.
          await tx.insert(connectedPages).values({ tenantId, pageId: data.pageId, ...rowValues })
        }
      })
    } catch (err) {
      const pgCode = (err as { code?: string })?.code
      if (pgCode === '23505') {
        return { ok: false, error: 'already_connected', message: 'This page is already connected to another account.' }
      }
      return { ok: false, error: 'db_failed', message: 'DB upsert failed.' }
    }

    // Clear the session cookie using the same attributes as set to ensure reliable deletion
    setCookie(SESSION_COOKIE, '', { ...SESSION_COOKIE_ATTRS, maxAge: 0 })

    return { ok: true, pageId: data.pageId, pageName }
  })
