import { SEND_MIN_ATTEMPT_MS } from '~/lib/media-constants'

const META_API_BASE = 'https://graph.facebook.com/v19.0'
const TIMEOUT_MS = 5000
const MAX_RETRIES = 3

type SendResult =
  | { ok: true; messageId: string }
  | {
      ok: false
      error: 'token_expired' | 'outside_window' | 'permission_denied' | 'invalid_request' | 'meta_server_error' | 'timeout'
      // 010: error==='timeout' の内訳。'budget' = 共有 deadline の残余不足で Meta を呼ばず打ち切り、
      // 'http' = 実 fetch タイムアウト。呼び出し側が観測ログの reason を正確に出せるようにする。
      timeoutKind?: 'budget' | 'http'
    }

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 010: テキスト送信は `messageText`、画像送信は `imageUrl` (presigned GET URL) を渡す。
// どちらか一方のみ。`deadlineMs` を渡すと、複数通の合計を単一の時間予算に収めるため
// 各試行前に残余時間で fetch timeout を切り詰め、残余が SEND_MIN_ATTEMPT_MS 未満なら
// Meta を呼ばずに timeout を返す (contracts §5)。省略時は従来と完全同一挙動。
export async function sendMessengerReply(params: {
  pageAccessToken: string
  recipientPsid: string
  messageText?: string
  imageUrl?: string
  deadlineMs?: number
}): Promise<SendResult> {
  const { pageAccessToken, recipientPsid, messageText, imageUrl, deadlineMs } = params

  // messageText / imageUrl は排他必須 (XOR)。両方未指定 or 両方指定は呼び出し側のバグ。
  // 空テキスト送信や意図しない分岐を避けるため即 invalid_request で弾く。
  const hasText = messageText !== undefined
  const hasImage = imageUrl !== undefined
  if (hasText === hasImage) {
    return { ok: false, error: 'invalid_request' }
  }

  const message = hasImage
    ? { attachment: { type: 'image', payload: { url: imageUrl, is_reusable: false } } }
    : { text: messageText }

  const body = JSON.stringify({
    recipient: { id: recipientPsid },
    messaging_type: 'RESPONSE',
    message,
  })

  let lastError: SendResult = { ok: false, error: 'meta_server_error' }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff. MAX_RETRIES=3 では attempt=1,2 の 2 回のみ発生するため
      // 実際に効くのは 500ms と 1500ms (4500ms には到達しない)。
      await sleep(500 * Math.pow(3, attempt - 1))
    }

    // 共有 deadline: 残余がこれ未満なら以降の試行を打ち切り、fetch timeout を残余でクランプ。
    let timeoutMs = TIMEOUT_MS
    if (deadlineMs !== undefined) {
      const remaining = deadlineMs - Date.now()
      if (remaining < SEND_MIN_ATTEMPT_MS) {
        return { ok: false, error: 'timeout', timeoutKind: 'budget' }
      }
      timeoutMs = Math.min(TIMEOUT_MS, remaining)
    }

    let response: Response
    try {
      response = await fetch(
        `${META_API_BASE}/me/messages?access_token=${pageAccessToken}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        },
      )
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        lastError = { ok: false, error: 'timeout', timeoutKind: 'http' }
        // Retry once on timeout; 2 回目の timeout は timeout(http) として確定する
        if (attempt < 1) continue
        return lastError
      }
      return { ok: false, error: 'meta_server_error' }
    }

    if (response.ok) {
      let data: { message_id?: string; recipient_id?: string }
      try {
        data = (await response.json()) as { message_id?: string; recipient_id?: string }
      } catch {
        return { ok: false, error: 'meta_server_error' }
      }
      if (typeof data.message_id !== 'string' || data.message_id.length === 0) {
        return { ok: false, error: 'meta_server_error' }
      }
      return { ok: true, messageId: data.message_id }
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
