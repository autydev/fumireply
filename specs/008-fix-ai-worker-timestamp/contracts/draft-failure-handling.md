# Contract: draft ジョブの境界クエリ・失敗ハンドリング・リトライラダー

**Feature**: 008-fix-ai-worker-timestamp
**Scope**: プロダクションコードは `ai-worker/src/handler.ts` のみ(app / webhook / terraform は変更なし)。テストは ai-worker の 2 ファイルに加え、handler を独自 DB モックで駆動する app 統合テスト 2 ファイル(`app/tests/integration/ai-draft-worker.test.ts` / `ai-draft-uses-conversation-settings.test.ts`)も C1 のクエリ形状に追随する

## C1. 未返信バッチ境界クエリ

`processDraftJob` の読みトランザクション内、最終 outbound 時刻の取得:

```ts
// BEFORE (バグ): 生 SQL — string が返り gt() で TypeError
const [lastOut] = await tx
  .select({ ts: sql<Date | null>`max(${messages.timestamp})` })
  .from(messages)
  .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'outbound')))

// AFTER: 型付きカラム select — drizzle が Date にマッピング
const [lastOut] = await tx
  .select({ ts: messages.timestamp })
  .from(messages)
  .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'outbound')))
  .orderBy(desc(messages.timestamp))
  .limit(1)
const lastOutboundTs = lastOut?.ts ?? new Date(0)
```

保証:
- `lastOutboundTs` は常に `Date`(outbound なしは `new Date(0)` フォールバック — 既存挙動)
- 後続 `gt(messages.timestamp, lastOutboundTs)` の未返信判定結果は修正前(意図)と同一
- `summary.ts:116` の `sql<string>` は正しいため変更しない

## C2. outer try/catch(pending 放置防止)

### シグネチャ変更

```ts
processDraftJob(input: {
  conversationId: string
  triggerMessageId?: string
  triggerType?: 'regenerate'
  instruction?: string
  receiveCount: number   // 新設: SQSRecord.attributes.ApproximateReceiveCount を parseInt した値(欠損時は 1)
}): Promise<void>
```

`processRecord(record)` が `record.attributes.ApproximateReceiveCount` から `receiveCount` を解決して渡す。summary ジョブ・legacy ジョブ経路も同様に渡す(legacy も draft ジョブなので同契約)。

### catch 契約

tenant 解決(step 1)の**後**から結果書き込みまで(`generateDraft` として抽出)を try/catch で包む。tenant 解決自体は catch の外 — tenantId なしでは終端状態を書き込めないため、ここでの失敗は従来どおり SQS リトライ → DLQ に委ねる。既存の Anthropic 呼び出し周りの内側 catch(API エラー→コード変換)は不変で、outer catch は「それ以外の予期しない例外」(DB クエリ、SSM、プロンプト構築等)を受ける。

| 条件 | 動作 |
|------|------|
| `receiveCount < MAX_RECEIVE_COUNT (3)` | `draft_job_unexpected_error` (willRetry=true) をログ → **rethrow**(SQS 再配信に委ねる。draft は書き込まない) |
| `receiveCount >= 3` | `draft_job_unexpected_error` (willRetry=false) をログ → 終端状態を書き込み → **正常 return** |
| 終端書き込み自体が throw | rethrow(DLQ 行き → 既存 `ai-worker-dlq-not-empty` アラーム) |
| tenant 解決(catch 外)が throw | rethrow(従来どおり SQS リトライ → DLQ) |

`MAX_RECEIVE_COUNT = 3` は `terraform/modules/queue/main.tf` の `maxReceiveCount` と一致させる定数としてコード内に定義し、コメントで対応関係を明記する。

### 終端状態の書き込み内容

既存の結果書き込み(`status IN ('pending','ready')` の行を対象)と同一の update 文を使う:

- auto: `{ status: 'failed', error: 'internal_error' }`
- regenerate: `{ status: 'ready', error: 'internal_error' }`(body/model/tokens に触れない — 005 保証の維持)
- `latencyMs` は計測不能な経路がありうるため null 許容(計測済みならその値)
- 対象行が存在しない場合(update 0 行)も正常終了(既存挙動と同じ)

### 例外にしない既存の早期 return

`conversation_not_found` / `superseded` / `no_unanswered` / SQS ボディの parse 失敗は従来どおり正常終了であり、outer catch の対象外(throw しない)。

## C3. リトライラダー定数

```ts
// BEFORE: 最悪 30s×4 + (1+3+9)s = 133s > Lambda timeout 60s
const ANTHROPIC_TIMEOUT_MS = 30_000
const RETRY_DELAYS_MS = [1000, 3000, 9000]

// AFTER: 最悪 15s×3 + (1+3)s = 49s、全体 ≒55s < 60s
const ANTHROPIC_TIMEOUT_MS = 15_000
const RETRY_DELAYS_MS = [1000, 3000]
```

- リトライ対象(429/5xx/ネットワーク)・非対象(429 以外の 4xx は即 throw)の判定ロジックは不変
- terraform (`ai-worker-lambda` timeout=60 / `queue` visibility=90) は変更しない

## C4. 構造化ログ

| event | level | fields | 発火タイミング |
|-------|-------|--------|----------------|
| `draft_job_unexpected_error` | error | `conversationId`, `receiveCount`, `willRetry`, `error`(String(err)) | outer catch 到達ごと(新設) |
| `draft_persisted` | info | 既存フィールド | 終端失敗書き込み後も既存どおり出る(status='failed' or 'ready') |
| `draft_regenerate_failed` | info | 既存フィールド | regenerate の `internal_error` 終端でも既存条件で出る |

## C5. クライアント互換性(変更なしの確認)

- `DraftBanner.tsx` は `status='ready'` + `error != null` → regenerate 失敗トースト、`status='failed'` → バナー消滅(auto の既存挙動)。`internal_error` は既存コードパスで表示されるため **app 側変更なし**
- ポーリング上限(regenerate 90s / auto 60s)に対し、最悪ケースでも ≒55s で終端状態が書かれる(C3)ため、正常系・失敗系ともポーリング窓内に決着する(非最終受信の rethrow → SQS 再配信のケースを除く。この場合クライアントはタイムアウト表示になるが、draft は最終的に必ず終端状態に達する)
