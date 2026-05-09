import { http, HttpResponse } from 'msw'

const GRAPH_BASE = 'https://graph.facebook.com/v19.0'

// ---------------------------------------------------------------------------
// Happy-path defaults
// ---------------------------------------------------------------------------

export const DEFAULT_LONG_TOKEN = 'EAA-long-user-token'
export const DEFAULT_PAGE_ID = '111222333444555'
export const DEFAULT_PAGE_NAME = 'Malbek Test Page'
export const DEFAULT_PAGE_ACCESS_TOKEN = 'EAA-page-access-token'

/** Happy-path handler for GET /v19.0/oauth/access_token (fb_exchange_token) */
export const exchangeTokenSuccess = http.get(`${GRAPH_BASE}/oauth/access_token`, () =>
  HttpResponse.json({
    access_token: DEFAULT_LONG_TOKEN,
    token_type: 'bearer',
    expires_in: 5183999,
  }),
)

/** Error 190 — short-lived token expired */
export const exchangeTokenExpired = http.get(`${GRAPH_BASE}/oauth/access_token`, () =>
  HttpResponse.json(
    { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190, fbtrace_id: 'abc' } },
    { status: 400 },
  ),
)

/** Error 4 — rate limited */
export const exchangeTokenRateLimited = http.get(`${GRAPH_BASE}/oauth/access_token`, () =>
  HttpResponse.json(
    { error: { message: 'Application request limit reached.', type: 'OAuthException', code: 4, fbtrace_id: 'def' } },
    { status: 400 },
  ),
)

/** Happy-path handler for GET /v19.0/me/accounts — one page */
export const listPagesSuccess = http.get(`${GRAPH_BASE}/me/accounts`, () =>
  HttpResponse.json({
    data: [
      {
        id: DEFAULT_PAGE_ID,
        name: DEFAULT_PAGE_NAME,
        access_token: DEFAULT_PAGE_ACCESS_TOKEN,
      },
    ],
    paging: { cursors: { before: 'b', after: 'a' } },
  }),
)

/** Empty pages response */
export const listPagesEmpty = http.get(`${GRAPH_BASE}/me/accounts`, () =>
  HttpResponse.json({ data: [], paging: { cursors: { before: 'b', after: 'a' } } }),
)

/** Error 200 — pages_show_list permission missing */
export const listPagesPermissionMissing = http.get(`${GRAPH_BASE}/me/accounts`, () =>
  HttpResponse.json(
    { error: { message: 'Permissions error', type: 'OAuthException', code: 200, fbtrace_id: 'ghi' } },
    { status: 403 },
  ),
)

/** Error 190 — long-lived token expired on /me/accounts */
export const listPagesTokenExpired = http.get(`${GRAPH_BASE}/me/accounts`, () =>
  HttpResponse.json(
    { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190, fbtrace_id: 'jkl' } },
    { status: 400 },
  ),
)

/** Error 4 — rate limited on /me/accounts */
export const listPagesRateLimited = http.get(`${GRAPH_BASE}/me/accounts`, () =>
  HttpResponse.json(
    { error: { message: 'Application request limit reached.', type: 'OAuthException', code: 4, fbtrace_id: 'mno' } },
    { status: 400 },
  ),
)

/** Happy-path handler for POST /v19.0/{page-id}/subscribed_apps */
export const subscribeWebhookSuccess = http.post(
  `${GRAPH_BASE}/:pageId/subscribed_apps`,
  () => HttpResponse.json({ success: true }),
)

/** Error 190 — page access token invalid */
export const subscribeWebhookTokenInvalid = http.post(
  `${GRAPH_BASE}/:pageId/subscribed_apps`,
  () =>
    HttpResponse.json(
      { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190, fbtrace_id: 'pqr' } },
      { status: 400 },
    ),
)

/** Error 200 — pages_manage_metadata permission missing */
export const subscribeWebhookPermissionMissing = http.post(
  `${GRAPH_BASE}/:pageId/subscribed_apps`,
  () =>
    HttpResponse.json(
      { error: { message: 'Permissions error', type: 'OAuthException', code: 200, fbtrace_id: 'stu' } },
      { status: 403 },
    ),
)

/** Error 803 — Webhook URL verification failed */
export const subscribeWebhookUrlFailed = http.post(
  `${GRAPH_BASE}/:pageId/subscribed_apps`,
  () =>
    HttpResponse.json(
      { error: { message: 'No Application associated with this Page.', type: 'OAuthException', code: 803, fbtrace_id: 'vwx' } },
      { status: 400 },
    ),
)

// ---------------------------------------------------------------------------
// Convenience bundles
// ---------------------------------------------------------------------------

/** All three happy-path handlers for the full connect flow */
export const fullFlowHappyPath = [exchangeTokenSuccess, listPagesSuccess, subscribeWebhookSuccess]
