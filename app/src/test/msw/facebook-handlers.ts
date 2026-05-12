import { http, HttpResponse } from 'msw'

const META_BASE = 'https://graph.facebook.com/v19.0'

// --- fb_exchange_token ---

export function exchangeTokenSuccess(opts?: { token?: string; expiresIn?: number }) {
  return http.get(`${META_BASE}/oauth/access_token`, () =>
    HttpResponse.json({
      access_token: opts?.token ?? 'LONG_LIVED_USER_TOKEN',
      token_type: 'bearer',
      expires_in: opts?.expiresIn ?? 5183999,
    }),
  )
}

export function exchangeTokenError(code: number, status = 400) {
  return http.get(`${META_BASE}/oauth/access_token`, () =>
    HttpResponse.json(
      {
        error: {
          message: `Graph error ${code}`,
          type: 'OAuthException',
          code,
          fbtrace_id: 'trace_xyz',
        },
      },
      { status },
    ),
  )
}

export function exchangeTokenServerError(status = 500) {
  return http.get(`${META_BASE}/oauth/access_token`, () =>
    HttpResponse.json({ error: 'upstream' }, { status }),
  )
}

// --- /me/accounts ---

export type MockPage = { id: string; name: string; access_token: string }

export function listPagesSuccess(pages: MockPage[], opts?: { nextUrl?: string }) {
  return http.get(`${META_BASE}/me/accounts`, () =>
    HttpResponse.json({
      data: pages,
      paging: opts?.nextUrl ? { next: opts.nextUrl, cursors: { before: 'b', after: 'a' } } : { cursors: { before: 'b', after: 'a' } },
    }),
  )
}

export function listPagesEmpty() {
  return http.get(`${META_BASE}/me/accounts`, () =>
    HttpResponse.json({ data: [], paging: { cursors: { before: '', after: '' } } }),
  )
}

export function listPagesError(code: number, status = 400) {
  return http.get(`${META_BASE}/me/accounts`, () =>
    HttpResponse.json(
      {
        error: { message: `Graph error ${code}`, type: 'OAuthException', code, fbtrace_id: 'trace_xyz' },
      },
      { status },
    ),
  )
}

// --- subscribed_apps ---

export function subscribeSuccess(pageId: string) {
  return http.post(`${META_BASE}/${pageId}/subscribed_apps`, () =>
    HttpResponse.json({ success: true }),
  )
}

export function subscribeError(pageId: string, code: number, status = 400) {
  return http.post(`${META_BASE}/${pageId}/subscribed_apps`, () =>
    HttpResponse.json(
      {
        error: { message: `Graph error ${code}`, type: 'OAuthException', code, fbtrace_id: 'trace_xyz' },
      },
      { status },
    ),
  )
}

// --- Combined happy-path helper ---

export function fullHappyPath(pageId: string, pages: MockPage[]) {
  return [exchangeTokenSuccess(), listPagesSuccess(pages), subscribeSuccess(pageId)]
}
