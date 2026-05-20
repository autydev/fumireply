# Contract: Summary Job (SQS + ai-worker dispatch)

**Feature**: 会話コンテキストの永続化と設定の階層化
**Scope**: 要約パイプラインの SQS メッセージ契約と ai-worker 内部の job 分岐契約。

---

## SQS Queue: `ai-summary-queue` (NEW)

新規キュー 1 本。属性は既存 `ai-draft-queue` を参考に設定。

| 属性 | 値 (推奨) | 理由 |
|---|---|---|
| Visibility Timeout | 60 秒 | Anthropic 要約呼び出し p95 < 20 秒 + DB UPDATE。Lambda 関数の timeout (60 秒) と揃える |
| Message Retention | 4 日 (デフォルト) | 障害時の retry 余地 |
| DLQ | `ai-summary-dlq` を作る | maxReceiveCount = 3。DLQ には conversation_id が残るので手動 redrive 可能 |
| FIFO | No (Standard) | 順序保証不要。冪等性は handler 側で再判定 |
| Encryption | SSE | 既存方針継続 |

Terraform は `terraform/modules/queue` を 1 度呼び出すブロックを `terraform/envs/review/main.tf` に追加。

---

## SQS Message Body Schema (送信側)

`maybeEnqueueSummaryJob(conversationId)` ヘルパが送信する body の Zod スキーマ:

```ts
const SUMMARY_JOB_SCHEMA = z.object({
  jobType: z.literal('summary'),
  conversationId: z.string().uuid(),
  enqueuedAt: z.string().datetime(),     // ISO 8601 — debug/observability 用
})
```

JSON 例:

```json
{
  "jobType": "summary",
  "conversationId": "abc-...",
  "enqueuedAt": "2026-05-20T12:34:56.789Z"
}
```

**注**: 既存 ai-draft-queue のメッセージは `{ messageId: '...' }` の形 (jobType フィールドなし)。後方互換のため ai-worker の dispatch は「`jobType` 欠落 → draft 経路」とする (R-001 参照)。

---

## ai-worker handler dispatch (MODIFY)

`ai-worker/src/handler.ts` の `processRecord(record)` を以下の形に変更:

```ts
async function processRecord(record: SQSRecord): Promise<void> {
  const body = JSON.parse(record.body)

  // 後方互換: jobType 欠落は draft 扱い
  const jobType = body.jobType ?? 'draft'

  if (jobType === 'draft') {
    await processDraftJob(body)
  } else if (jobType === 'summary') {
    await processSummaryJob(body)
  } else {
    console.error({ event: 'unknown_job_type', jobType, rawBody: record.body })
    // 例外を投げずに正常終了 (poison メッセージで Lambda リトライしないため)
  }
}
```

- `processDraftJob` は現行 `processRecord` の中身を関数化したもの (SQS_BODY_SCHEMA + 既存処理)。プロンプト合成は `prompt-composition.md` の通り 5 段に拡張。
- `processSummaryJob` は新規。`SUMMARY_JOB_SCHEMA` でバリデーション後、`summary.ts` の関数を呼ぶ。

---

## `processSummaryJob(body: SummaryJob)` の振る舞い

`ai-worker/src/summary.ts` (新規) に置く。

```ts
export async function processSummaryJob(body: SummaryJob): Promise<void>
```

### ステップ

1. **conversationId バリデーション**: Zod でパース失敗なら error ログのみで正常終了 (DLQ に投げない方針 — メッセージ形式不正なら手動修正)
2. **テナント解決**: `dbAdmin` で `SELECT tenant_id FROM conversations WHERE id = $1`。行なしなら `event: 'conversation_not_found'` で正常終了
3. **しきい値再判定 (冪等性、R-006)**: `withTenant` トランザクションで:
   - `SELECT summary, last_summarized_at FROM conversations WHERE id = $1`
   - `SELECT direction, body, timestamp FROM messages WHERE conversation_id = $1 AND message_type = 'text' AND timestamp > COALESCE(last_summarized_at, '1970-01-01'::timestamptz) ORDER BY timestamp ASC LIMIT 200`
   - 累計 `SUM(LENGTH(body))` を計算
   - 2,000 文字未満なら `event: 'summary_skipped_below_threshold'` で正常終了
4. **Anthropic 呼び出し**: `buildSummaryPrompt(existingSummary, messages)` で system+user を組み立て、Anthropic Haiku 4.5 を呼ぶ。timeout 30 秒、retry [1s, 3s, 9s] (既存 draft と同じパターン)
5. **永続化**: 同一 `withTenant` トランザクションを再度開き:
   - `UPDATE conversations SET summary = $1, last_summarized_at = $2 WHERE id = $3` (`$2` は messages 配列の最終 `timestamp`)
6. **ログ**: 各ステップで構造化ログ:
   - `{ event: 'summary_started', tenant_id, conversation_id, messages_in_summary }`
   - `{ event: 'summary_completed', tenant_id, conversation_id, prompt_tokens, completion_tokens, latency_ms }`
   - `{ event: 'summary_failed', tenant_id, conversation_id, error }`

### 失敗時の挙動

- Anthropic 401/400: throw して SQS リトライ (DLQ 行き)
- Anthropic 429/5xx: retry 後に throw して SQS リトライ
- DB 失敗: throw して SQS リトライ
- バリデーション失敗 / conversation not found / threshold not met: 正常終了 (DLQ には送らない)

### Idempotency

- ステップ 3 のしきい値再判定により、すでに別の job が要約を更新した直後の重複 enqueue は no-op で消費される
- ステップ 5 の UPDATE が「自分の手元の messages 配列の最終 timestamp」を使うため、UPDATE 直前に新着メッセージが入っても次回の job がそれを拾うだけ (取りこぼしなし)

---

## `buildSummaryPrompt(existingSummary, messages)` 契約

`ai-worker/src/prompt.ts` に追加する純粋関数。

### Input

```ts
existingSummary: string | null
messages: Array<{ direction: 'inbound' | 'outbound'; body: string; timestamp: Date }>
```

### Output (Anthropic 形式)

```ts
{
  system: string   // 要約用システムプロンプト (英語固定)
  user: string     // 既存要約 (あれば) + 新規メッセージ列
}
```

### Prompt 内容方針

- **system**: "You are a conversation summarizer for a customer service inbox. Produce a concise summary (max 500 characters) of the conversation between operator and customer. Focus on: customer's stated needs, decisions made, important facts the operator needs to remember (e.g., preferred payment method, shipping address fragments, product preferences). Write in the same language as the conversation. Output the summary text only with no preamble."
- **user**: 既存要約があれば `Previous summary:\n<text>\n\nNew messages since last summary:\n[customer]: ...\n[operator]: ...\n\nProduce an updated summary that incorporates both.` の形。既存要約なしなら `Messages:\n...\n\nProduce a summary.` の形。

### 純粋関数性

- DB アクセスなし。テストは入出力比較のみ。

---

## Terraform 差分 (概要)

`terraform/envs/review/main.tf` に以下を追加 (擬似):

```hcl
module "ai_summary_queue" {
  source = "../../modules/queue"
  name   = "ai-summary-queue"
  visibility_timeout = 60
  max_receive_count  = 3
  # ... 既存 queue モジュールのインターフェースに準拠 ...
}

# ai-worker Lambda に 2 つ目の event source mapping を追加
resource "aws_lambda_event_source_mapping" "ai_summary_source" {
  event_source_arn = module.ai_summary_queue.arn
  function_name    = module.ai_worker_lambda.function_arn
  batch_size       = 1
}
```

`terraform/modules/ai-worker-lambda/main.tf` は IAM ポリシーに新キューの `sqs:ReceiveMessage` / `sqs:DeleteMessage` / `sqs:GetQueueAttributes` を追加。既存ポリシーへの最小増分。

---

## env 変数 (新規)

ai-worker と app-lambda 両方で参照:

| 名前 | 値 | 用途 |
|---|---|---|
| `AI_SUMMARY_QUEUE_URL` | (Terraform で注入) | app-lambda が SQS send に使う |
| `SUMMARY_TRIGGER_THRESHOLD_CHARS` | `2000` (デフォルト) | `maybeEnqueueSummaryJob` の閾値 |
| `SUMMARY_PIPELINE_ENABLED` | `'true'` / `'false'` | `'false'` で ai-worker が summary jobType を即時 no-op 消費 (障害時スイッチ) |
