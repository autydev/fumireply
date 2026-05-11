import { getSsmParameter } from './ssm'

const META_GRAPH_BASE = 'https://graph.facebook.com/v19.0'
const TIMEOUT_MS = 10000
const MAX_RETRIES = 3
const MAX_PAGES = 50

type Logger = {
  info: (record: Record<string, unknown>) => void
  warn: (record: Record<string, unknown>) => void
  error: (record: Record<string, unknown>) => void
}

const defaultLogger: Logger = {
  info: (r) => console.log(JSON.stringify(r)),
  warn: (r) => console.warn(JSON.stringify(r)),
  error: (r) => console.error(JSON.stringify(r)),
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type GraphError = { code?: number; type?: string; message?: string; fbtrace_id?: string }

async function parseGraphError(response: Response): Promise<GraphError> {
  try {
    const body = (await response.json()) as { error?: GraphError }
    return body.error ?? {}
  } catch {
    return {}
  }
}

function getAppId(): string {
  const appId = process.env.VITE_FB_APP_ID?.trim()
  if (!appId) throw new Error('VITE_FB_APP_ID is required')
  return appId
}

async function getAppSecret(): Promise<string> {
  const key = process.env.META_APP_SECRET_SSM_KEY?.trim()
  if (!key) throw new Error('META_APP_SECRET_SSM_KEY is required')
  return getSsmParameter(key)
}

// === 1. fb_exchange_token ===

export type ExchangeUserTokenResult =
  | { ok: true; longLivedUserToken: string; expiresIn: number }
  | { ok: false; error: 'token_expired' | 'rate_limited' | 'meta_unavailable' | 'internal_error'; errorCode?: number }

export async function exchangeUserToken(
  shortLivedUserToken: string,
  logger: Logger = defaultLogger,
): Promise<ExchangeUserTokenResult> {
  const start = Date.now()
  let appId: string
  let appSecret: string
  try {
    appId = getAppId()
    appSecret = await getAppSecret()
  } catch {
    logger.error({ event: 'fb_exchange_token', status: 'failure', reason: 'env_or_ssm', duration_ms: Date.now() - start })
    return { ok: false, error: 'internal_error' }
  }

  const url = new URL(`${META_GRAPH_BASE}/oauth/access_token`)
  url.searchParams.set('grant_type', 'fb_exchange_token')
  url.searchParams.set('client_id', appId)
  url.searchParams.set('client_secret', appSecret)
  url.searchParams.set('fb_exchange_token', shortLivedUserToken)

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(1000 * Math.pow(2, attempt - 1))

    let response: Response
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch {
      if (attempt === MAX_RETRIES - 1) {
        logger.error({ event: 'fb_exchange_token', status: 'failure', reason: 'network_or_timeout', duration_ms: Date.now() - start })
        return { ok: false, error: 'meta_unavailable' }
      }
      continue
    }

    if (response.ok) {
      const data = (await response.json()) as { access_token?: string; expires_in?: number }
      if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
        logger.error({ event: 'fb_exchange_token', status: 'failure', reason: 'malformed_response', duration_ms: Date.now() - start })
        return { ok: false, error: 'internal_error' }
      }
      logger.info({
        event: 'fb_exchange_token',
        status: 'success',
        expires_in: data.expires_in ?? 0,
        duration_ms: Date.now() - start,
      })
      return { ok: true, longLivedUserToken: data.access_token, expiresIn: data.expires_in ?? 0 }
    }

    if (response.status >= 500) {
      if (attempt === MAX_RETRIES - 1) {
        logger.error({ event: 'fb_exchange_token', status: 'failure', http_status: response.status, duration_ms: Date.now() - start })
        return { ok: false, error: 'meta_unavailable' }
      }
      continue
    }

    const errBody = await parseGraphError(response)
    logger.warn({
      event: 'fb_exchange_token',
      status: 'failure',
      error_code: errBody.code,
      fbtrace_id: errBody.fbtrace_id,
      duration_ms: Date.now() - start,
    })
    if (errBody.code === 190) return { ok: false, error: 'token_expired', errorCode: 190 }
    if (errBody.code === 4) {
      if (attempt === MAX_RETRIES - 1) return { ok: false, error: 'rate_limited', errorCode: 4 }
      continue
    }
    return { ok: false, error: 'internal_error', errorCode: errBody.code }
  }

  return { ok: false, error: 'meta_unavailable' }
}

// === 2. /me/accounts ===

export type FacebookPage = {
  id: string
  name: string
  pageAccessToken: string
}

export type ListPagesResult =
  | { ok: true; pages: FacebookPage[]; hasNextPage: boolean }
  | { ok: false; error: 'token_expired' | 'permission_missing' | 'rate_limited' | 'meta_unavailable' | 'internal_error'; errorCode?: number }

export async function listPages(
  longLivedUserToken: string,
  logger: Logger = defaultLogger,
): Promise<ListPagesResult> {
  const start = Date.now()
  const url = new URL(`${META_GRAPH_BASE}/me/accounts`)
  url.searchParams.set('access_token', longLivedUserToken)
  url.searchParams.set('fields', 'id,name,access_token')

  const allPages: FacebookPage[] = []
  let nextUrl: URL | null = url
  let hasNextPage = false

  while (nextUrl !== null) {
    const currentUrl: URL = nextUrl

    let response: Response | null = null
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(1000 * Math.pow(2, attempt - 1))
      try {
        response = await fetch(currentUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      } catch {
        if (attempt === MAX_RETRIES - 1) {
          logger.error({ event: 'me_accounts', status: 'failure', reason: 'network_or_timeout', duration_ms: Date.now() - start })
          return { ok: false, error: 'meta_unavailable' }
        }
        continue
      }
      if (response.ok) break
      if (response.status >= 500) {
        if (attempt === MAX_RETRIES - 1) {
          logger.error({ event: 'me_accounts', status: 'failure', http_status: response.status, duration_ms: Date.now() - start })
          return { ok: false, error: 'meta_unavailable' }
        }
        continue
      }
      // 4xx — break out and handle
      break
    }

    if (response === null) return { ok: false, error: 'meta_unavailable' }

    if (!response.ok) {
      const errBody = await parseGraphError(response)
      logger.warn({
        event: 'me_accounts',
        status: 'failure',
        error_code: errBody.code,
        fbtrace_id: errBody.fbtrace_id,
        duration_ms: Date.now() - start,
      })
      if (errBody.code === 190) return { ok: false, error: 'token_expired', errorCode: 190 }
      if (errBody.code === 200) return { ok: false, error: 'permission_missing', errorCode: 200 }
      if (errBody.code === 4) return { ok: false, error: 'rate_limited', errorCode: 4 }
      return { ok: false, error: 'internal_error', errorCode: errBody.code }
    }

    const data = (await response.json()) as {
      data?: Array<{ id?: string; name?: string; access_token?: string }>
      paging?: { next?: string }
    }
    for (const p of data.data ?? []) {
      if (typeof p.id === 'string' && typeof p.name === 'string' && typeof p.access_token === 'string') {
        allPages.push({ id: p.id, name: p.name, pageAccessToken: p.access_token })
        if (allPages.length >= MAX_PAGES) break
      }
    }
    if (allPages.length >= MAX_PAGES) {
      hasNextPage = Boolean(data.paging?.next) || allPages.length === MAX_PAGES
      break
    }
    nextUrl = typeof data.paging?.next === 'string' ? new URL(data.paging.next) : null
  }

  logger.info({
    event: 'me_accounts',
    status: 'success',
    page_count: allPages.length,
    has_next_page: hasNextPage,
    duration_ms: Date.now() - start,
  })
  return { ok: true, pages: allPages, hasNextPage }
}

// === 3. subscribed_apps ===

export type SubscribePageResult =
  | { ok: true }
  | { ok: false; error: 'token_invalid' | 'permission_missing' | 'webhook_url_failed' | 'rate_limited' | 'meta_unavailable' | 'internal_error'; errorCode?: number }

export async function subscribePageWebhook(
  pageId: string,
  pageAccessToken: string,
  logger: Logger = defaultLogger,
): Promise<SubscribePageResult> {
  const start = Date.now()
  const url = new URL(`${META_GRAPH_BASE}/${pageId}/subscribed_apps`)
  url.searchParams.set('subscribed_fields', 'messages,messaging_postbacks')
  url.searchParams.set('access_token', pageAccessToken)

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(1000 * Math.pow(2, attempt - 1))

    let response: Response
    try {
      response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch {
      if (attempt === MAX_RETRIES - 1) {
        logger.error({ event: 'subscribe_apps', status: 'failure', page_id: pageId, reason: 'network_or_timeout', duration_ms: Date.now() - start })
        return { ok: false, error: 'meta_unavailable' }
      }
      continue
    }

    if (response.ok) {
      const data = (await response.json().catch(() => ({}))) as { success?: boolean }
      if (data.success !== true) {
        logger.error({ event: 'subscribe_apps', status: 'failure', page_id: pageId, reason: 'unexpected_body', duration_ms: Date.now() - start })
        return { ok: false, error: 'internal_error' }
      }
      logger.info({
        event: 'subscribe_apps',
        status: 'success',
        page_id: pageId,
        fields: ['messages', 'messaging_postbacks'],
        duration_ms: Date.now() - start,
      })
      return { ok: true }
    }

    if (response.status >= 500) {
      if (attempt === MAX_RETRIES - 1) {
        logger.error({ event: 'subscribe_apps', status: 'failure', page_id: pageId, http_status: response.status, duration_ms: Date.now() - start })
        return { ok: false, error: 'meta_unavailable' }
      }
      continue
    }

    const errBody = await parseGraphError(response)
    logger.warn({
      event: 'subscribe_apps',
      status: 'failure',
      page_id: pageId,
      error_code: errBody.code,
      fbtrace_id: errBody.fbtrace_id,
      duration_ms: Date.now() - start,
    })
    if (errBody.code === 190) return { ok: false, error: 'token_invalid', errorCode: 190 }
    if (errBody.code === 200) return { ok: false, error: 'permission_missing', errorCode: 200 }
    if (errBody.code === 803) return { ok: false, error: 'webhook_url_failed', errorCode: 803 }
    if (errBody.code === 4) {
      if (attempt === MAX_RETRIES - 1) return { ok: false, error: 'rate_limited', errorCode: 4 }
      continue
    }
    return { ok: false, error: 'internal_error', errorCode: errBody.code }
  }

  return { ok: false, error: 'meta_unavailable' }
}
