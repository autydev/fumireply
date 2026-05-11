import { count, eq, sql } from 'drizzle-orm'
import { connectedPages } from '~/server/db/schema'
import type { TenantTx } from '~/server/db/with-tenant'
import { encryptToken, getMasterKey } from '~/server/services/crypto'
import {
  subscribePageWebhook,
  type SubscribePageResult,
} from '~/server/services/facebook'

export type ConnectPageInput = {
  pageId: string
  pageName: string
  pageAccessToken: string
}

export type ConnectPageSuccess = {
  ok: true
  pageId: string
  pageName: string
}

export type ConnectPageFailure = {
  ok: false
  error:
    | 'already_connected'
    | 'subscribe_failed'
    | 'token_invalid'
    | 'permission_missing'
    | 'webhook_url_failed'
    | 'encryption_failed'
    | 'db_failed'
    | 'meta_unavailable'
    | 'internal_error'
  message: string
}

export type ConnectPageResult = ConnectPageSuccess | ConnectPageFailure

const ERROR_MESSAGE: Record<ConnectPageFailure['error'], string> = {
  already_connected: 'onboarding_error_already_connected',
  subscribe_failed: 'onboarding_error_subscribe_failed',
  token_invalid: 'onboarding_error_token_expired',
  permission_missing: 'onboarding_error_permission_missing',
  webhook_url_failed: 'onboarding_error_subscribe_failed',
  encryption_failed: 'onboarding_error_generic',
  db_failed: 'onboarding_error_generic',
  meta_unavailable: 'onboarding_error_meta_unavailable',
  internal_error: 'onboarding_error_generic',
}

function failure(error: ConnectPageFailure['error']): ConnectPageFailure {
  return { ok: false, error, message: ERROR_MESSAGE[error] }
}

function mapSubscribeError(result: Extract<SubscribePageResult, { ok: false }>): ConnectPageFailure {
  if (result.error === 'token_invalid') return failure('token_invalid')
  if (result.error === 'permission_missing') return failure('permission_missing')
  if (result.error === 'webhook_url_failed') return failure('webhook_url_failed')
  if (result.error === 'meta_unavailable') return failure('meta_unavailable')
  return failure('subscribe_failed')
}

export type ConnectPageDeps = {
  subscribePageWebhook: typeof subscribePageWebhook
  encryptToken: typeof encryptToken
  getMasterKey: typeof getMasterKey
  getWebhookVerifyTokenSsmKey: () => string
}

const defaultDeps: ConnectPageDeps = {
  subscribePageWebhook,
  encryptToken,
  getMasterKey,
  getWebhookVerifyTokenSsmKey: () => {
    const key = process.env.WEBHOOK_VERIFY_TOKEN_SSM_KEY?.trim()
    if (!key) throw new Error('WEBHOOK_VERIFY_TOKEN_SSM_KEY is required')
    return key
  },
}

export async function handleConnectPage(
  tx: TenantTx,
  tenantId: string,
  input: ConnectPageInput,
  deps: ConnectPageDeps = defaultDeps,
): Promise<ConnectPageResult> {
  // Reverse guard: refuse if tenant already has a connected page
  const existing = await tx
    .select({ value: count() })
    .from(connectedPages)
    .where(eq(connectedPages.isActive, true))
  if ((existing[0]?.value ?? 0) > 0) {
    return failure('already_connected')
  }

  const subscribeResult = await deps.subscribePageWebhook(input.pageId, input.pageAccessToken)
  if (!subscribeResult.ok) return mapSubscribeError(subscribeResult)

  let encrypted: Buffer
  let webhookVerifyTokenSsmKey: string
  try {
    const masterKey = await deps.getMasterKey()
    encrypted = deps.encryptToken(input.pageAccessToken, masterKey)
    webhookVerifyTokenSsmKey = deps.getWebhookVerifyTokenSsmKey()
  } catch {
    return failure('encryption_failed')
  }

  try {
    await tx
      .insert(connectedPages)
      .values({
        tenantId,
        pageId: input.pageId,
        pageName: input.pageName,
        pageAccessTokenEncrypted: encrypted,
        webhookVerifyTokenSsmKey,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: connectedPages.pageId,
        set: {
          pageName: input.pageName,
          pageAccessTokenEncrypted: encrypted,
          isActive: true,
          // refresh tenant_id only if RLS permits — same tenant only
          tenantId: sql`EXCLUDED.tenant_id`,
        },
      })
  } catch {
    return failure('db_failed')
  }

  return { ok: true, pageId: input.pageId, pageName: input.pageName }
}
