# Contract: Meta Webhook Receiver

**Endpoint**: `POST /api/webhook`, `GET /api/webhook`
**Implementation**: 専用 Lambda（`webhook/`）。SSR Lambda とは独立してデプロイされる。
**Spec reference**: FR-001, FR-003, FR-004, FR-017, FR-022〜FR-024
**External spec**: https://developers.facebook.com/docs/messenger-platform/webhooks
**Updated**: 2026-04-30 (SQS enqueue を追加、AI 下書き生成キックオフ)

本アプリが Meta に対して提供する受信エンドポイントの契約。Meta App Dashboard で Callback URL として登録する。受信 Lambda は **同期で署名検証 → DB INSERT → ai_drafts pending insert → SQS enqueue → 200** までを行い、AI 下書き生成は Worker Lambda に分離する（R-001 / FR-017）。

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
| テキストメッセージ | `entry[].messaging[].message.text` | `messages` に INSERT (`message_type='text'`) → `ai_drafts` に `status='pending'` で INSERT → SQS enqueue |
| スタンプ | `entry[].messaging[].message.attachments[].payload.sticker_id` | `messages` INSERT (`message_type='sticker'`, `body=''`)。**AI 下書きは生成しない**（テキストでないため） |
| 画像 | `entry[].messaging[].message.attachments[].type='image'` | `messages` INSERT (`message_type='image'`, `body=<attachment URL>`)。**AI 下書きは生成しない** |
| Echo（自分の送信） | `entry[].messaging[].message.is_echo=true` | `meta_message_id` で既に存在する行を UPDATE（`send_status='sent'`） |
| delivery / read | `entry[].messaging[].delivery` or `.read` | MVP では無視（200 返却のみ） |

### 処理フロー（POST 詳細）

1. ヘッダ `X-Hub-Signature-256` を取得
2. `app-secret` を SSM から取得（メモリキャッシュ）
3. `crypto.timingSafeEqual` で HMAC-SHA256 検証 → 失敗時 401
4. zod で payload バリデーション → 失敗時 200 + `parse_error` ログ（Meta 再送ループ回避）
5. トランザクションで以下を実行：
   - `conversations` を upsert（`page_id` + `customer_psid` で UNIQUE 制約）
   - `messages` を INSERT（`INSERT ... ON CONFLICT (meta_message_id) DO NOTHING`）
   - `messages.message_type = 'text'` の場合のみ `ai_drafts` に `status='pending'` で INSERT（`ON CONFLICT (message_id) DO NOTHING`、再配信耐性）
6. `ai_drafts` を INSERT した場合、SQS に `{ messageId: <messages.id> }` を enqueue
7. 200 + `EVENT_RECEIVED` 返却

### Response

| Status | Body | 条件 |
|--------|------|------|
| 200 | `EVENT_RECEIVED` (text/plain) | 署名検証成功、処理完了（SQS enqueue 失敗してもベストエフォートで 200 を返し、CloudWatch にエラー記録）|
| 401 | `Invalid signature` | 署名検証失敗 |

**時間制約**: すべて **20 秒以内**に応答（FR-017）。実装目標 p95 < 2 秒（AI 呼び出しは含めないため余裕を持って達成可能）。

### 冪等性

- 同一 `message.mid` が複数回配信された場合でも `messages.meta_message_id` の UNIQUE 制約により 1 件のみ保存される。
- `ai_drafts.message_id` も UNIQUE のため、SQS が再配信しても下書きは 1 件のみ。SQS Worker 側でも `INSERT ... ON CONFLICT` で冪等化済み。
- 実装は `INSERT ... ON CONFLICT (meta_message_id) DO NOTHING RETURNING id` で「実際に挿入されたか」を判定し、SQS enqueue は新規挿入時のみ実行（重複 enqueue 回避）。

### エラー処理

- 署名検証失敗 → 401、ログに `signature_invalid` イベント記録
- JSON パース失敗 → 200（Meta の再送による無限ループ回避）、ログに `parse_error` 記録
- DB エラー → 500、Meta 側で再送。再送回数上限を超えた場合は CloudWatch アラームで検知
- SQS enqueue 失敗 → ログに記録、200 を返す（次回の Webhook 再送に頼らず、`ai_drafts.status='pending'` のまま残るため Phase 2 でリトライバッチ実装）

---

## SQS メッセージ仕様

```json
{
  "messageId": "<messages.id UUID>"
}
```

- ペイロードに **メッセージ本文を載せない**（PII を SQS に流さない、Worker 側で DB から取得する設計）
- Standard Queue（FIFO 不要、Worker 側で `messages.id` の冪等処理あり）
- Visibility Timeout: 90 秒（Worker Lambda タイムアウト 60 秒 + マージン）

---

## 署名検証のアルゴリズム

```
expected = 'sha256=' + HMAC-SHA256(APP_SECRET, raw_request_body).hexdigest()
received = headers['X-Hub-Signature-256']

timingSafeEqual(expected, received)  // 定数時間比較
```

- `APP_SECRET` は SSM Parameter Store から取得
- `raw_request_body` は parser を通す前の bytes で計算（API Gateway イベントの `body` を base64 デコード前のまま）

---

## テスト

| Test | Type | Coverage |
|------|------|----------|
| 正常系（text メッセージ）| integration | 署名正 → 200 + DB に `messages` 1 件 + `ai_drafts` 1 件 + SQS enqueue 1 件 |
| 正常系（重複配信）| integration | 同一 mid を 2 回 POST → `messages` / `ai_drafts` ともに 1 件のみ、SQS enqueue も 1 件のみ |
| 正常系（sticker）| integration | `message_type='sticker'` で INSERT、ai_drafts は作成されない、SQS enqueue されない |
| 異常系（署名不正）| unit | 401、DB に追加されない |
| 異常系（body 改竄）| unit | 署名不一致 → 401 |
| 検証フロー（GET）| integration | 正しい verify_token → 200 + challenge そのまま |
| 検証フロー（不正トークン）| integration | 403 |
| Echo イベント | integration | 自分の送信メッセージを UPDATE、ai_drafts INSERT しない |
| SQS enqueue 失敗 | integration | SQS クライアントを失敗モック → 200 返却 + エラーログ |
