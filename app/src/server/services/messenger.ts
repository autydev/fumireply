const META_API_BASE = 'https://graph.facebook.com/v19.0'
const TIMEOUT_MS = 5000
const MAX_RETRIES = 3

type SendResult =
  | { ok: true; messageId: string }
  | {
      ok: false
      error: 'token_expired' | 'outside_window' | 'permission_denied' | 'invalid_request' | 'meta_server_error' | 'timeout'
    }

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function sendMessengerReply(params: {
  pageAccessToken: string
  recipientPsid: string
  messageText: string
}): Promise<SendResult> {
  const { pageAccessToken, recipientPsid, messageText } = params

  const body = JSON.stringify({
    recipient: { id: recipientPsid },
    messaging_type: 'RESPONSE',
    message: { text: messageText },
  })

  let lastError: SendResult = { ok: false, error: 'meta_server_error' }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 500ms, 1500ms, 4500ms
      await sleep(500 * Math.pow(3, attempt - 1))
    }

    let response: Response
    try {
      response = await fetch(
        `${META_API_BASE}/me/messages?access_token=${pageAccessToken}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      )
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        lastError = { ok: false, error: 'timeout' }
        // Retry once on timeout
        if (attempt < 1) continue
      }
      return { ok: false, error: 'meta_server_error' }
    }

    if (response.ok) {
      const data = (await response.json()) as { message_id?: string; recipient_id?: string }
      return { ok: true, messageId: data.message_id ?? '' }
    }

    // 5xx: retry
    if (response.status >= 500) {
      lastError = { ok: false, error: 'meta_server_error' }
      continue
    }

    // 4xx: no retry
    if (response.status === 403) {
      return { ok: false, error: 'permission_denied' }
    }

    if (response.status === 400) {
      let errBody: { error?: { code?: number; error_subcode?: number } } = {}
      try {
        errBody = (await response.json()) as typeof errBody
      } catch {
        return { ok: false, error: 'invalid_request' }
      }
      const code = errBody.error?.code
      const subcode = errBody.error?.error_subcode

      if (code === 190) return { ok: false, error: 'token_expired' }
      if (code === 10 && subcode === 2018278) return { ok: false, error: 'outside_window' }
      return { ok: false, error: 'invalid_request' }
    }

    return { ok: false, error: 'meta_server_error' }
  }

  return lastError
}
