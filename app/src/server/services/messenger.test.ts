import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { sendMessengerReply } from './messenger'

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
})
