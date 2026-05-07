const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0'
const TIMEOUT_MS = 10000

type FbErrorResponse = { error: { code: number; message: string; fbtrace_id?: string } }

function isFbError(body: unknown): body is FbErrorResponse {
  return typeof body === 'object' && body !== null && 'error' in body
}

async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  const delays = [1000, 2000, 4000]
  let lastError: Error | undefined

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (init?.signal?.aborted) throw init.signal.reason ?? new Error('Request aborted')

    const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS)
    const signal: AbortSignal =
      init?.signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([timeoutSignal, init.signal])
        : timeoutSignal

    try {
      const res = await fetch(url, { ...init, signal })

      if (res.status < 500 || attempt === delays.length) return res

      // Discard the body before retrying to allow connection reuse
      await res.body?.cancel().catch(() => {})
      lastError = new Error(`HTTP ${res.status}`)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (init?.signal?.aborted) throw lastError
    }

    if (attempt < delays.length) {
      await new Promise((r) => setTimeout(r, delays[attempt]))
    }
  }

  throw lastError ?? new Error('fetch failed')
}

export interface ExchangedToken {
  accessToken: string
  expiresIn: number
}

export async function exchangeUserToken(
  shortLivedToken: string,
  appId: string,
  appSecret: string,
): Promise<ExchangedToken> {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortLivedToken,
  })

  const res = await fetchWithRetry(`${GRAPH_API_BASE}/oauth/access_token?${params}`)
  const body = (await res.json()) as unknown

  if (isFbError(body)) {
    const code = body.error.code
    if (code === 190) throw Object.assign(new Error('token_expired'), { fbCode: code })
    if (code === 4) throw Object.assign(new Error('rate_limited'), { fbCode: code })
    throw Object.assign(new Error('meta_unavailable'), { fbCode: code })
  }

  const data = body as { access_token: string; expires_in: number }
  return { accessToken: data.access_token, expiresIn: data.expires_in }
}

export interface FbPage {
  id: string
  name: string
  pageAccessToken: string
}

export async function listPages(longUserToken: string): Promise<FbPage[]> {
  const params = new URLSearchParams({
    access_token: longUserToken,
    fields: 'id,name,access_token',
    limit: '50',
  })

  const pages: FbPage[] = []
  let nextUrl: string | undefined = `${GRAPH_API_BASE}/me/accounts?${params}`

  while (nextUrl) {
    const res = await fetchWithRetry(nextUrl)
    const body = (await res.json()) as unknown

    if (isFbError(body)) {
      const code = (body as FbErrorResponse).error.code
      if (code === 200) throw Object.assign(new Error('permission_missing'), { fbCode: code })
      if (code === 190) throw Object.assign(new Error('token_expired'), { fbCode: code })
      if (code === 4) throw Object.assign(new Error('rate_limited'), { fbCode: code })
      throw Object.assign(new Error('meta_unavailable'), { fbCode: code })
    }

    const data = body as { data: Array<{ id: string; name: string; access_token: string }>; paging?: { next?: string } }
    for (const page of data.data) {
      pages.push({ id: page.id, name: page.name, pageAccessToken: page.access_token })
      if (pages.length >= 50) break
    }

    nextUrl = pages.length < 50 ? data.paging?.next : undefined
  }

  return pages
}

export async function subscribePageWebhook(
  pageId: string,
  pageAccessToken: string,
): Promise<void> {
  const params = new URLSearchParams({
    subscribed_fields: 'messages,messaging_postbacks',
    access_token: pageAccessToken,
  })

  const res = await fetchWithRetry(`${GRAPH_API_BASE}/${pageId}/subscribed_apps`, {
    method: 'POST',
    body: params,
  })

  const body = (await res.json()) as unknown

  if (isFbError(body)) {
    const code = (body as FbErrorResponse).error.code
    if (code === 190) throw Object.assign(new Error('token_invalid'), { fbCode: code })
    if (code === 200) throw Object.assign(new Error('permission_missing'), { fbCode: code })
    if (code === 803) throw Object.assign(new Error('webhook_url_failed'), { fbCode: code })
    throw Object.assign(new Error('subscribe_failed'), { fbCode: code })
  }
}
