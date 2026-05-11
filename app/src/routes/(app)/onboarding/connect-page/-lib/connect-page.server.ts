import { getCookie, setCookie } from '@tanstack/react-start/server'
import { and, eq } from 'drizzle-orm'
import { connectedPages } from '~/server/db/schema'
import { withTenant } from '~/server/db/with-tenant'
import { decryptToken, encryptToken, getMasterKey } from '~/server/services/crypto'
import { listPages, subscribePageWebhook } from '~/server/services/facebook'
import { env } from '~/server/env'
import type { ConnectPageResult } from './connect-page.fn'

const SESSION_COOKIE = 'fb_connect_session'
const SESSION_COOKIE_ATTRS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
}

// Exported for integration testing. The server fn wrapper passes context.user.tenantId
// so tenant isolation is enforced at the auth layer, not here.
export async function handleConnectPage(tenantId: string, pageId: string): Promise<ConnectPageResult> {
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

  const encodedSession = getCookie(SESSION_COOKIE)
  if (!encodedSession) {
    return { ok: false, error: 'token_invalid', message: 'Session expired. Please reconnect.' }
  }

  let pageAccessToken: string
  let pageName: string
  let longToken: string
  try {
    const masterKey = await getMasterKey()
    longToken = decryptToken(Buffer.from(encodedSession, 'base64'), masterKey)
  } catch {
    // Tampered or corrupted cookie — clear it and force re-connect
    setCookie(SESSION_COOKIE, '', { ...SESSION_COOKIE_ATTRS, maxAge: 0 })
    return { ok: false, error: 'token_invalid', message: 'Session invalid. Please reconnect.' }
  }

  try {
    const pages = await listPages(longToken)
    const page = pages.find((p) => p.id === pageId)
    if (!page) {
      return { ok: false, error: 'token_invalid', message: 'Selected page not found. Please reconnect.' }
    }
    pageAccessToken = page.pageAccessToken
    pageName = page.name
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    if (msg === 'token_expired') return { ok: false, error: 'token_invalid', message: 'Session expired. Please reconnect.' }
    if (msg === 'permission_missing') return { ok: false, error: 'permission_missing', message: 'Missing pages_show_list permission.' }
    if (msg === 'rate_limited') return { ok: false, error: 'rate_limited', message: 'Rate limited. Please wait.' }
    if (msg === 'meta_unavailable') return { ok: false, error: 'meta_unavailable', message: 'Facebook API unavailable.' }
    return { ok: false, error: 'internal_error', message: 'Failed to retrieve page token.' }
  }

  try {
    await subscribePageWebhook(pageId, pageAccessToken)
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
      const existing = await tx
        .select({ id: connectedPages.id })
        .from(connectedPages)
        .where(and(eq(connectedPages.tenantId, tenantId), eq(connectedPages.pageId, pageId)))
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
        await tx.insert(connectedPages).values({ tenantId, pageId, ...rowValues })
      }
    })
  } catch (err) {
    const pgCode = (err as { code?: string })?.code
    if (pgCode === '23505') {
      return { ok: false, error: 'already_connected', message: 'This page is already connected to another account.' }
    }
    return { ok: false, error: 'db_failed', message: 'DB upsert failed.' }
  }

  setCookie(SESSION_COOKIE, '', { ...SESSION_COOKIE_ATTRS, maxAge: 0 })

  return { ok: true, pageId, pageName }
}
