import { and, eq } from 'drizzle-orm'
import { connectedPages } from '~/server/db/schema'
import type { TenantTx } from '~/server/db/with-tenant'
import { decryptToken, encryptToken, getMasterKey } from '~/server/services/crypto'
import { fetchPageWithToken, subscribePageWebhook } from '~/server/services/facebook'
import { env } from '~/server/env'

export const SESSION_COOKIE = 'fb_connect_session'
export const SESSION_COOKIE_ATTRS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
}

export type ConnectPageResult =
  | { ok: true; pageId: string; pageName: string }
  | { ok: false; error: 'already_connected' | 'subscribe_failed' | 'token_invalid' | 'permission_missing' | 'webhook_url_failed' | 'encryption_failed' | 'db_failed' | 'meta_unavailable' | 'rate_limited' | 'internal_error'; message: string }

// Server-only. Exported for integration testing — mirrors the production handler's
// sequence (reverse-guard → session decrypt → fetchPageWithToken → subscribe →
// encrypt → UPSERT → clear session) on a single mock tx. Production splits this
// across two withTenant transactions with external I/O between them; this
// single-tx form is the test-only full-flow version (same convention as
// handleSendReply in send-reply.server.ts).
export async function handleConnectPage(
  tx: TenantTx,
  tenantId: string,
  data: { pageId: string },
  session: { encodedSession: string | undefined; clearSession: () => void },
): Promise<ConnectPageResult> {
  try {
    const activeExisting = await tx
      .select({ id: connectedPages.id })
      .from(connectedPages)
      .where(and(eq(connectedPages.tenantId, tenantId), eq(connectedPages.isActive, true)))
      .limit(1)
    if (activeExisting.length > 0) {
      return { ok: false, error: 'already_connected', message: 'Page already connected.' }
    }
  } catch {
    return { ok: false, error: 'db_failed', message: 'DB check failed.' }
  }

  if (!session.encodedSession) {
    return { ok: false, error: 'token_invalid', message: 'Session expired. Please reconnect.' }
  }

  let pageAccessToken: string
  let pageName: string
  try {
    const masterKey = await getMasterKey()
    const longToken = decryptToken(Buffer.from(session.encodedSession, 'base64'), masterKey)
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
      await tx.insert(connectedPages).values({ tenantId, pageId: data.pageId, ...rowValues })
    }
  } catch (err) {
    const pgCode = (err as { code?: string })?.code
    if (pgCode === '23505') {
      return { ok: false, error: 'already_connected', message: 'This page is already connected to another account.' }
    }
    return { ok: false, error: 'db_failed', message: 'DB upsert failed.' }
  }

  session.clearSession()

  return { ok: true, pageId: data.pageId, pageName }
}
