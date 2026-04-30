# Contract: Meta Send API (Outbound)

**Direction**: This app → Meta Graph API
**Spec reference**: FR-005, FR-006, FR-007, FR-008
**External spec**: https://developers.facebook.com/docs/messenger-platform/send-messages
**Endpoint (Meta side)**: `POST https://graph.facebook.com/v19.0/me/messages`

管理画面の「送信」操作から呼び出す Meta への送信契約。

---

## Request (to Meta)

### URL Parameters

| Param | Value | Source |
|-------|-------|--------|
| `access_token` | `<Page Access Token>` | `connected_pages.page_access_token_encrypted` を復号して取得 |

### Headers

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |

### Body (JSON)

```json
{
  "recipient": { "id": "<PSID>" },
  "messaging_type": "RESPONSE",
  "message": {
    "text": "<reply body>"
  }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `recipient.id` | string | 返信対象の `conversations.customer_psid` |
| `messaging_type` | string | MVP では固定値 `RESPONSE`（24 時間窓内の返信）|
| `message.text` | string | 最大 2000 文字。改行は `\n` |

**MVP では `message_tag` / `MESSAGE_TAG` / `NON_PROMOTIONAL_SUBSCRIPTION` は使用しない**（24 時間窓外送信は Out of Scope のため）。

---

## Response (from Meta)

### 成功時

| Status | Body |
|--------|------|
| 200 | `{ "recipient_id": "<PSID>", "message_id": "m_abc123..." }` |

→ アプリ側処理：
- `messages.send_status = 'sent'`
- `messages.meta_message_id = <message_id>`

### 失敗時

| Status | Body 例 | アプリ側処理 |
|--------|---------|--------------|
| 400 | `{ "error": { "message": "...", "type": "OAuthException", "code": 190 } }` | トークン失効。`send_status='failed'`, `send_error='token_expired'`、管理画面に警告バナー表示 |
| 400 | `{ "error": { "code": 10, "error_subcode": 2018278 } }` | 24 時間窓超過。`send_error='outside_24h_window'` |
| 400 | `{ "error": { "code": 100 } }` | パラメータ不正。`send_error='invalid_request'` + 詳細ログ |
| 403 | 権限なし | 審査未通過の権限を使った場合。`send_error='permission_denied'` |
| 5xx | Meta 側障害 | `send_error='meta_server_error'`、ユーザーにリトライを促す |

---

## Pre-send Validation

送信前にアプリ側で以下を検証：

1. `conversations.last_inbound_at` が現在時刻の 24 時間以内
   - 外れていたら送信を実行せず、管理画面で警告表示（FR-008）
2. 本文が 2000 文字以内
3. 本文が空でないこと（空送信は API がエラーを返すが先に弾く）

---

## Retry Strategy

- **5xx エラー**：3 回まで指数バックオフ（1s, 3s, 9s）でリトライ
- **4xx エラー**：リトライしない（トークン失効や 24 時間窓超過はユーザー対応が必要）
- **タイムアウト（10 秒）**：リトライ 1 回まで

---

## セキュリティ

- Page Access Token は DB 暗号化カラム（`connected_pages.page_access_token_encrypted`）から復号して使用し、平文は永続化しない
- ログには `access_token` を**絶対に出力しない**（構造化ログのフィールドから除外）
- エラーレスポンスをそのままログ出力する際は `access_token` をマスクする

---

## テスト

| Test | Type | Approach |
|------|------|----------|
| 正常系（成功）| unit | Meta API を `msw` でモック、成功レスポンス |
| 異常系（トークン失効）| unit | モック 400 + code 190 → `send_status='failed'` |
| 異常系（24h 窓超過）| unit | モック 400 + subcode 2018278 |
| リトライ（5xx）| unit | 1 回目 500、2 回目 200 で成功 |
| 事前検証（24h 超過）| unit | `last_inbound_at` 操作で API 呼び出し自体を抑止 |
| E2E（審査リハーサル）| manual | 実 Meta API を叩いてテスト FB ページに送信 |
