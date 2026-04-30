# Contract: AI Draft Generation Worker

**Direction**: SQS → Worker Lambda → Anthropic API → DB
**Implementation**: 専用 Lambda（`ai-worker/`）。SQS Trigger で起動。
**Spec reference**: FR-022, FR-023, FR-024, FR-025, FR-026, SC-008
**External**: https://docs.anthropic.com/en/api/messages
**Date**: 2026-04-30

Webhook 受信 Lambda が enqueue した SQS メッセージをトリガに、Anthropic Claude Haiku 4.5 で返信下書きを生成し `ai_drafts` テーブルに保存する Worker Lambda の契約。**Send API は呼ばない**（FR-026 Human-in-the-Loop 必須）。

---

## SQS メッセージ入力

`contracts/meta-webhook.md` で定義された形式。

```json
{
  "messageId": "<messages.id UUID>"
}
```

Lambda は SQS Event Source Mapping で起動。Batch Size = 1（並列処理しやすく、1 件失敗が他に影響しない）。

---

## 処理フロー

1. SQS event の `Records[0].body` から JSON パースして `messageId` を取得
2. **service role 接続で `messages.tenant_id` を取得**（`SELECT tenant_id FROM messages WHERE id = $1`、RLS バイパス）。見つからなければスキップ成功扱い
3. **`withTenant(tenant_id, async (tx) => ...)` 内で以下を実行**：
   - `messages` から `body`, `message_type`, `conversation_id` を取得
   - `message_type !== 'text'` ならスキップして成功扱い（ガード）
   - 同一 conversation の直近 N 件（MVP では N=5）の messages を取得（会話履歴を prompt に含めるため）
4. SSM から Anthropic API キー取得（メモリキャッシュ、TTL 5 分、全テナント共通）
5. Anthropic API を呼び出し（後述「Anthropic API 呼び出し」節）
6. 成功/失敗のいずれも、引き続き `withTenant(tenant_id, ...)` 内で `ai_drafts` を UPDATE：
   - 成功時：
     ```sql
     UPDATE ai_drafts
     SET status='ready', body=$body, model=$model,
         prompt_tokens=$inp, completion_tokens=$out,
         latency_ms=$ms, updated_at=NOW()
     WHERE message_id = $messageId;
     ```
     （RLS により tenant_id 不一致なら影響行 0、これは異常）
   - 失敗時：`status='failed'`, `error`, `latency_ms` を UPDATE
8. SQS メッセージは正常終了で自動 ACK（throw しない）。`status='failed'` も Lambda としては「成功」扱い（DLQ には流さない）
9. Lambda 自体が throw した場合（SDK バグ、SSM 取得失敗等）は SQS が自動再配信。MaxReceiveCount=3 を超えたら DLQ へ

---

## Anthropic API 呼び出し

### Endpoint

`POST https://api.anthropic.com/v1/messages`

### Headers

| Header | Value |
|--------|-------|
| `x-api-key` | SSM `/fumireply/review/anthropic/api-key` の値 |
| `anthropic-version` | `2023-06-01` |
| `content-type` | `application/json` |

### Request Body

```json
{
  "model": "claude-haiku-4-5-20251001",
  "max_tokens": 300,
  "system": [
    {
      "type": "text",
      "text": "<システムプロンプト本文>",
      "cache_control": { "type": "ephemeral" }
    }
  ],
  "messages": [
    { "role": "user", "content": "<user prompt>" }
  ]
}
```

**Prompt Caching**: `system` ブロックに `cache_control: { type: 'ephemeral' }` を付与し、システムプロンプト（FAQ・トーン指示等の固定部分）を Anthropic 側でキャッシュさせる。2 回目以降の呼び出しは入力トークンを 90% 割引で扱える。

### システムプロンプト

```
You are a helpful customer support assistant for a TCG (trading card game) retailer.
The customer is messaging on Facebook Messenger asking about products.

Generate a single reply draft based on the customer's latest message and recent
conversation history. The draft will be reviewed and edited by a human operator
before sending — never assume the draft will be sent verbatim.

Guidelines:
- Keep the reply polite and concise (max 300 characters).
- If the customer asks a specific question (price, stock, shipping), answer directly
  if the information is in the conversation; otherwise ask one clarifying question.
- Match the customer's language (Japanese / English).
- Do not include placeholders like [PRICE] or [STOCK] — write what you would actually say.
- Output the reply text only, with no preamble like "Draft:" or "Here is the reply:".
```

### User Prompt の組み立て

直近 5 件のメッセージを時系列順に整形する：

```
Recent conversation:
[customer]: Hi, do you still have the Charizard EX in stock?
[operator]: Yes, we have one left at ¥3,500.
[customer]: Can you ship it to Australia?

Generate a reply to the latest customer message.
```

ターゲット message が会話履歴の最後（[customer]）にあること。テキスト以外のメッセージタイプは prompt に含めない。

### Response (success)

```json
{
  "id": "msg_abc123",
  "type": "message",
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Yes, we ship internationally to Australia. Shipping takes 7–14 days and costs around ¥2,000. Would you like me to prepare an invoice?" }
  ],
  "model": "claude-haiku-4-5-20251001",
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 250,
    "output_tokens": 45,
    "cache_creation_input_tokens": 200,
    "cache_read_input_tokens": 0
  }
}
```

→ アプリ側処理：
- `ai_drafts.body = content[0].text`
- `ai_drafts.model = response.model`
- `ai_drafts.prompt_tokens = usage.input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
- `ai_drafts.completion_tokens = usage.output_tokens`

### Response (error)

| Status | エラー種別 | アプリ側処理 |
|--------|-----------|-------------|
| 401 | API キー失効 | `error='auth_failed'` で UPDATE。CloudWatch アラーム → 運営に通知 |
| 429 | レート制限 | リトライ対象。指数バックオフ後に再試行（後述）|
| 500-503 | Anthropic 側障害 | リトライ対象 |
| 400 | プロンプトサイズ超過等 | `error='bad_request'` でリトライしない |

---

## Retry Strategy

- **5xx / 429 エラー**：3 回まで指数バックオフ（1s, 3s, 9s）でリトライ
- **4xx エラー（401, 400）**：リトライしない（運用対応が必要）
- **タイムアウト（30 秒）**：リトライ 1 回まで
- **3 回リトライしても失敗**：`ai_drafts.status='failed'` で UPDATE して終了。SQS は ACK（DLQ には流さない、運用判断）。

ユーザー視点では、`status='failed'` のときスレッド画面は空入力欄を表示し人間が自由入力で送信できる（FR-025）。そのため失敗時の DLQ 救済より画面の自由入力フォールバックを優先する。

---

## セキュリティ

- Anthropic API キーは Lambda のメモリキャッシュ（SSM 呼び出しはコールドスタート時のみ）
- ログには `x-api-key` を**絶対に出力しない**
- ユーザーメッセージ本文を CloudWatch Logs にも出力しない（PII 配慮、エラーログには message_id のみ）
- Anthropic に送信するメッセージ本文は Privacy Policy で明示済み（R-008）

---

## パフォーマンス目標

- p95 receive → ai_drafts.ready：< 60 秒（SC-008、Lambda コールドスタート + Anthropic レイテンシ含む）
- Anthropic API 呼び出し p95：< 5 秒（Haiku 4.5 の typical レイテンシ）
- Lambda メモリ：512 MB（Anthropic SDK + DB クライアント + Web 経由の I/O 中心）

---

## テスト

| Test | Type | Approach |
|------|------|----------|
| 正常系（text メッセージ）| unit | Anthropic API を MSW でモック → ai_drafts.body / prompt_tokens / completion_tokens / model が正しく保存されることを確認 |
| 異常系（API キー失効 401）| unit | モック 401 → ai_drafts.status='failed', error='auth_failed' |
| 異常系（429 レート制限）| unit | 1 回目 429、2 回目 200 → リトライ後成功 |
| 異常系（5xx）| unit | 3 回連続 503 → ai_drafts.status='failed', error='server_error' |
| メッセージ未存在 | unit | DB に messageId が無い → スキップして成功（古い SQS メッセージのリプレイ対応）|
| message_type=sticker | unit | スキップして成功 |
| Prompt Caching（cache_read）| integration | 2 回目以降の呼び出しで cache_read_input_tokens > 0 を確認 |
| 会話履歴の組み立て | unit | 直近 5 件の messages から prompt を構築するロジックの単体テスト |
| E2E（実 API、開発環境のみ）| manual | 実際の Anthropic API キーでテスト FB ページのメッセージから下書き生成、品質確認 |
