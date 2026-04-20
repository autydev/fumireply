# Contract: Meta Webhook Receiver

**Endpoint**: `POST /api/webhook`, `GET /api/webhook`
**Spec reference**: FR-001, FR-003, FR-004, FR-017
**External spec**: https://developers.facebook.com/docs/messenger-platform/webhooks

本アプリが Meta に対して提供する受信エンドポイントの契約。Meta App Dashboard で Callback URL として登録する。

---

## GET `/api/webhook` — Verification

アプリ購読登録時に Meta が購読元の正当性を検証する。

### Request (from Meta)

| Parameter | Type | Source | Notes |
|-----------|------|--------|-------|
| `hub.mode` | string | query | 固定値 `subscribe` |
| `hub.challenge` | string | query | Meta が生成するランダム文字列 |
| `hub.verify_token` | string | query | Meta 側に登録した secret と一致するか検証 |

### Response

| Status | Body | 条件 |
|--------|------|------|
| 200 | `<hub.challenge の値>` (text/plain) | `verify_token` が SSM の `webhook_verify_token_ssm_key` と一致した場合 |
| 403 | `Forbidden` | トークン不一致 |

---

## POST `/api/webhook` — Event Receive

Messenger メッセージや配信イベントを受信する。

### Request (from Meta)

#### Headers

| Header | Required | Notes |
|--------|----------|-------|
| `X-Hub-Signature-256` | YES | `sha256=<HMAC-SHA256(App Secret, body)>` の形式。**検証必須** |
| `Content-Type` | YES | `application/json` |

#### Body (JSON)

例: テキストメッセージ受信

```json
{
  "object": "page",
  "entry": [
    {
      "id": "<PAGE_ID>",
      "time": 1713630000000,
      "messaging": [
        {
          "sender": { "id": "<PSID>" },
          "recipient": { "id": "<PAGE_ID>" },
          "timestamp": 1713630000000,
          "message": {
            "mid": "m_abc123...",
            "text": "Hey, is this still available?"
          }
        }
      ]
    }
  ]
}
```

#### 受信するイベントタイプ（MVP スコープ）

| Type | Field | 処理 |
|------|-------|------|
| テキストメッセージ | `entry[].messaging[].message.text` | `messages` に INSERT (`message_type='text'`) |
| スタンプ | `entry[].messaging[].message.attachments[].payload.sticker_id` | INSERT (`message_type='sticker'`, `body=''`) |
| 画像 | `entry[].messaging[].message.attachments[].type='image'` | INSERT (`message_type='image'`, `body=<attachment URL>`) |
| Echo（自分の送信） | `entry[].messaging[].message.is_echo=true` | `meta_message_id` で既に存在する行を UPDATE（send_status='sent'） |
| delivery / read | `entry[].messaging[].delivery` or `.read` | MVP では無視（200 返却のみ） |

### Response

| Status | Body | 条件 |
|--------|------|------|
| 200 | `EVENT_RECEIVED` (text/plain) | 署名検証成功、処理完了 |
| 401 | `Invalid signature` | 署名検証失敗 |

**時間制約**: すべて **20 秒以内**に応答（FR-017）。超過した場合 Meta は再送し、連続失敗で Webhook が無効化される。

### 冪等性

同一 `message.mid` が複数回配信された場合でも `messages.meta_message_id` の UNIQUE 制約により 1 件のみ保存される。実装は `INSERT ... ON CONFLICT (meta_message_id) DO NOTHING`。

### エラー処理

- 署名検証失敗 → 401、ログに `signature_invalid` イベント記録
- JSON パース失敗 → 200（Meta の再送による無限ループ回避）、ログに `parse_error` 記録
- DB エラー → 500、Meta 側で再送。再送回数上限を超えた場合はログで検知

---

## 署名検証のアルゴリズム

```
expected = 'sha256=' + HMAC-SHA256(APP_SECRET, raw_request_body).hexdigest()
received = headers['X-Hub-Signature-256']

timingSafeEqual(expected, received)  // 定数時間比較
```

- `APP_SECRET` は SSM Parameter Store から取得
- `raw_request_body` は parser を通す前の bytes で計算（TanStack Start では `request.text()` を先に呼び、それを JSON.parse する）

---

## テスト

| Test | Type | Coverage |
|------|------|----------|
| 正常系（text メッセージ）| integration | 署名正 → 200 + DB に 1 件追加 |
| 正常系（重複配信）| integration | 同一 mid を 2 回 POST → DB に 1 件のみ |
| 異常系（署名不正）| unit | 401、DB に追加されない |
| 異常系（body 改竄）| unit | 署名不一致 → 401 |
| 検証フロー（GET）| integration | 正しい verify_token → 200 + challenge そのまま |
| 検証フロー（不正トークン）| integration | 403 |
| Echo イベント | integration | 自分の送信メッセージを UPDATE |
