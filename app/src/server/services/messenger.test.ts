// messenger.ts imports media-upload → env proxy validates on first access
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test'
process.env.DATABASE_URL_SERVICE_ROLE = 'postgresql://test:test@localhost:5432/test'
process.env.SUPABASE_URL = 'https://test.supabase.co'
process.env.SUPABASE_PUBLISHABLE_KEY = 'test-key'
process.env.SUPABASE_SECRET_KEY = 'test-secret'
process.env.META_APP_ID = 'test-app-id'
process.env.META_APP_SECRET_SSM_KEY = '/test/meta/secret'
process.env.WEBHOOK_VERIFY_TOKEN_SSM_KEY = '/test/webhook/token'
process.env.ANTHROPIC_API_KEY_SSM_KEY = '/test/anthropic/key'
process.env.AWS_REGION = 'ap-northeast-1'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { sendMessengerReply } from './messenger'
import { SEND_MIN_ATTEMPT_MS } from './media-upload'

const META_MESSAGES_URL = 'https://graph.facebook.com/v19.0/me/messages'

const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const baseParams = {
  pageAccessToken: 'test-page-access-token',
  recipientPsid: '123456789',
  messageText: 'Hello, how can I help you?',
}

describe('sendMessengerReply', () => {
  it('returns ok=true with messageId on success', async () => {
    server.use(
      http.post(META_MESSAGES_URL, () =>
        HttpResponse.json({ recipient_id: '123456789', message_id: 'm_abc123' }),
      ),
    )
    const result = await sendMessengerReply(baseParams)
    expect(result).toEqual({ ok: true, messageId: 'm_abc123' })
  })

  it('returns token_expired on 400 with code 190', async () => {
    server.use(
      http.post(META_MESSAGES_URL, () =>
        HttpResponse.json(
          { error: { message: 'Invalid token', type: 'OAuthException', code: 190 } },
          { status: 400 },
        ),
      ),
    )
    const result = await sendMessengerReply(baseParams)
    expect(result).toEqual({ ok: false, error: 'token_expired' })
  })

  it('returns outside_window on 400 with code 10 subcode 2018278', async () => {
    server.use(
      http.post(META_MESSAGES_URL, () =>
        HttpResponse.json(
          { error: { code: 10, error_subcode: 2018278 } },
          { status: 400 },
        ),
      ),
    )
    const result = await sendMessengerReply(baseParams)
    expect(result).toEqual({ ok: false, error: 'outside_window' })
  })

  it('returns permission_denied on 403', async () => {
    server.use(
      http.post(META_MESSAGES_URL, () =>
        HttpResponse.json({ error: { message: 'Forbidden' } }, { status: 403 }),
      ),
    )
    const result = await sendMessengerReply(baseParams)
    expect(result).toEqual({ ok: false, error: 'permission_denied' })
  })

  it('retries on 5xx and returns ok on eventual success', async () => {
    let callCount = 0
    server.use(
      http.post(META_MESSAGES_URL, () => {
        callCount++
        if (callCount < 2) {
          return HttpResponse.json({ error: 'server error' }, { status: 503 })
        }
        return HttpResponse.json({ recipient_id: '123', message_id: 'm_retry' })
      }),
    )
    const result = await sendMessengerReply(baseParams)
    expect(result).toEqual({ ok: true, messageId: 'm_retry' })
    expect(callCount).toBe(2)
  })

  it('returns meta_server_error after exhausting 5xx retries', async () => {
    server.use(
      http.post(META_MESSAGES_URL, () =>
        HttpResponse.json({ error: 'server error' }, { status: 503 }),
      ),
    )
    const result = await sendMessengerReply(baseParams)
    expect(result).toEqual({ ok: false, error: 'meta_server_error' })
  })

  // 010: 画像ペイロード形状
  it('sends image attachment payload when imageUrl is provided', async () => {
    let captured: unknown
    server.use(
      http.post(META_MESSAGES_URL, async ({ request }) => {
        captured = await request.json()
        return HttpResponse.json({ recipient_id: '123', message_id: 'm_img' })
      }),
    )
    const result = await sendMessengerReply({
      pageAccessToken: 'tok',
      recipientPsid: '123456789',
      imageUrl: 'https://s3.example.com/presigned-get',
    })
    expect(result).toEqual({ ok: true, messageId: 'm_img' })
    expect(captured).toMatchObject({
      recipient: { id: '123456789' },
      messaging_type: 'RESPONSE',
      message: {
        attachment: {
          type: 'image',
          payload: { url: 'https://s3.example.com/presigned-get', is_reusable: false },
        },
      },
    })
  })

  // 010: deadline 残余が SEND_MIN_ATTEMPT_MS 未満なら Meta を呼ばず timeout
  it('returns timeout without calling Meta when remaining budget is below the floor', async () => {
    let called = false
    server.use(
      http.post(META_MESSAGES_URL, () => {
        called = true
        return HttpResponse.json({ recipient_id: '123', message_id: 'm_x' })
      }),
    )
    // deadline は現在から SEND_MIN_ATTEMPT_MS 未満先
    const result = await sendMessengerReply({
      ...baseParams,
      deadlineMs: Date.now() + SEND_MIN_ATTEMPT_MS - 500,
    })
    expect(result).toEqual({ ok: false, error: 'timeout' })
    expect(called).toBe(false)
  })

  // 010: deadline 省略時は既存挙動 (この describe の他テストが担保) — 明示で 1 ケース
  it('behaves identically to text send when deadlineMs is omitted', async () => {
    server.use(
      http.post(META_MESSAGES_URL, () =>
        HttpResponse.json({ recipient_id: '123', message_id: 'm_nodl' }),
      ),
    )
    const result = await sendMessengerReply(baseParams)
    expect(result).toEqual({ ok: true, messageId: 'm_nodl' })
  })
})
