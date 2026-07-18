# Research: AI 下書き生成のクラッシュ修正と失敗時の確実な状態反映

**Feature**: 008-fix-ai-worker-timestamp | **Date**: 2026-07-18

## D1. 未返信バッチ境界クエリの修正方法

**Decision**: 生 SQL `max()` をやめ、型付きカラム select + `orderBy(desc())` + `limit(1)` に置き換える。

```ts
const [lastOut] = await tx
  .select({ ts: messages.timestamp })
  .from(messages)
  .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'outbound')))
  .orderBy(desc(messages.timestamp))
  .limit(1)
const lastOutboundTs = lastOut?.ts ?? new Date(0)
```

**Rationale**:
- `sql<Date | null>` は型アサーションにすぎず実行時変換をしない。drizzle の postgres-js ドライバはドライバ側日付パーサを無効化し、**型付きカラムの select のみ** Date にマッピングするため、生 SQL の `max(timestamp)` は string で返る。型付きカラム(`messages.timestamp` は `timestamp('timestamp', { withTimezone: true })`、schema.ts:116)で select すれば drizzle が Date に変換する
- `messages_tenant_id_conversation_id_timestamp_idx` があるため `ORDER BY timestamp DESC LIMIT 1` は index scan で `max()` と同等性能
- 境界判定のセマンティクス(最後の outbound 時刻、なければ epoch)は完全に同一

**Alternatives considered**:
- 生 SQL のまま `new Date(string)` で手動変換 — Postgres の timestamp 文字列表現への依存が残り、タイムゾーン解釈のバグ余地がある。却下
- `sql` フラグメントに `.mapWith(messages.timestamp)` を付与 — 動作はするが、コードベースに前例がなく可読性で劣る。型付き select の方が既存クエリ群(直前の coalesce クエリ等)と同型。却下

## D2. 予期しない例外での pending 放置防止(outer try/catch)

**Decision**: `processDraftJob` の本体全体を try/catch で包み、SQS レコードの `ApproximateReceiveCount` を引数で受け取って受信回数で挙動を分岐する:

- **非最終受信(receiveCount < 3)**: 構造化ログを出して **rethrow** → Lambda Invoke Error → SQS が visibility timeout (90s) 後に再配信。一時的な DB エラー等の自動回復を温存
- **最終受信(receiveCount >= 3 = maxReceiveCount)**: 失敗状態を書き込んで**正常終了**(swallow)。書き込み内容は既存仕様に従う — auto: `{ status: 'failed', error: 'internal_error' }` / regenerate: `{ status: 'ready', error: 'internal_error' }`(本文保持)。終端書き込み自体が失敗した場合は rethrow → DLQ 行き(既存 DLQ アラームが発火)

**Rationale**:
- 早期に `failed` を書いてしまうと、成功時の書き込みが `status IN ('pending','ready')` の行のみを対象とするため **SQS リトライが成功しても結果が反映されない**。終端受信まで書き込みを遅らせることでリトライ意味論を壊さない
- 今回のような決定的バグでも 3 回目の受信で必ず終端状態が書かれ、pending 放置(クライアントのポーリングタイムアウト待ち)が構造的に解消される
- swallow により正常系の DLQ 流入はなくなる。DLQ は本当の異常(catch 前のクラッシュ、Lambda timeout、終端書き込み失敗)専用となり、既存の `ai-worker-dlq-not-empty` アラームのシグナル純度が上がる
- `batch_size = 1` のため部分バッチ失敗の考慮は不要。`processRecord` から receiveCount を渡すだけでよい

**Alternatives considered**:
- 初回例外で即 `failed` を書いて swallow(fail-fast)— フィードバックは最速だが、一時的な DB エラーでの自動回復を失う。auto-batch はオペレーター不在で走るためリトライの価値が高い。却下
- 終端状態書き込み後にあえて rethrow して DLQ にも送る — アラームは発火するが、redrive 時に既に `failed` の行へ無駄な Anthropic 呼び出しが走る。ログ (`draft_job_unexpected_error`) で追跡可能なため不要。却下
- エラーコードは新設の `internal_error`。クライアント (`DraftBanner.tsx`) は `error` 非 null を透過的に regenerate 失敗トーストにするため、クライアント変更不要

**構造化ログイベント(新設)**:

| event | level | fields | 意味 |
|-------|-------|--------|------|
| `draft_job_unexpected_error` | error | conversationId, receiveCount, willRetry, error | outer catch 到達(毎回) |

終端書き込みは既存の `draft_persisted`(status=failed / ready)がそのまま出る。regenerate の失敗は既存の `draft_regenerate_failed` も出る。

## D3. Lambda timeout 60s とリトライラダーの整合

**Decision**: Lambda timeout は 60s のまま変更せず、Anthropic リトライラダーを短縮して収める:

- `ANTHROPIC_TIMEOUT_MS`: 30_000 → **15_000**
- `RETRY_DELAYS_MS`: `[1000, 3000, 9000]`(4 試行)→ **`[1000, 3000]`(3 試行)**
- 最悪ケース: 15s×3 + 遅延 4s = **49s**、DB/SSM オーバーヘッド込みで ≒55s < 60s

**Rationale**:
- クライアントのポーリング上限(auto 60s / regenerate 90s)内に**必ず**終端状態が書かれることを最優先(spec Assumptions)。Lambda timeout を 133s+ に延ばす案はこの上限を確実に超え、SQS visibility (90s) の引き上げも必要になり、DB 接続保持時間も延びる
- 現行モデル(claude-haiku-4-5、max_tokens 300)の応答は通常数秒。15s per-attempt は p99 に十分な余裕があり、30s は過剰
- terraform 変更ゼロで済む(`visibility 90s >= Lambda 60s` の既存関係を維持)

**Alternatives considered**:
- Lambda timeout 150s + visibility 150s+ に引き上げ — 最悪ケースでもラダーを完走できるが、クライアントは 90s で諦めた後に draft が ready になる「見えない成功」が生じ UX が悪化。DB 接続も長時間保持。却下
- timeout 90s + ラダー ~75s の折衷 — auto の 60s 窓を超える。visibility も 90s ちょうどで余裕ゼロ。却下

## D4. DLQ 滞留ジョブの後始末

**Decision**: redrive 手順(AWS コンソール or `aws sqs start-message-move-task`)と安全性の根拠・注意点を quickstart.md に文書化する。実施可否は修正デプロイ後の運用判断。

**Rationale**(redrive の安全性分析):
- ジョブは処理時点の DB 状態を再読みする。会話ごとの帰結は:
  - **新しい inbound がその後届いた会話**: coalesce により `superseded` → 副作用なし
  - **返信済みになった会話**: `no_unanswered` → アクティブ下書きの dismiss(これは 004 の設計どおりの正しい挙動 — 未返信がないのに残る下書きは stale)
  - **いまだ未返信で trigger が最新 inbound のままの会話**: 現時点の内容で下書きを生成(redrive の価値がある唯一のケース)
- 滞留分に regenerate ジョブが含まれる場合、coalesce をバイパスして古い operator 指示で現アクティブ下書きを上書きしうる。件数を確認し、含まれるなら redrive せず purge も選択肢(quickstart に記載)
- redrive しない場合は DLQ 保持 14 日で自然消滅

## D5. 回帰テスト戦略

**Decision**: `handler.test.ts` / `regenerate.test.ts` の `buildReadTx` モックを新クエリ形状(`select → from → where → orderBy → limit` 終端)に追随させ、以下を追加する:

1. **outbound あり会話の auto 生成**: `lastOutboundResult = [{ ts: new Date(...) }]` で draft が `ready` まで到達すること(修正前は string が混入する経路)
2. **outbound あり会話の regenerate**: 同上で regenerate が成功すること
3. **境界クエリ形状**: 最終 outbound クエリが `orderBy` + `limit(1)` 付きの型付き select であること(生 SQL に戻る退行の検知)
4. **outer catch — 非最終受信**: 読みトランザクションが throw する場合、`ApproximateReceiveCount: '1'` では handler が **rethrow**(reject)し、draft への書き込みが発生しないこと
5. **outer catch — 最終受信**: `ApproximateReceiveCount: '3'` では auto → `failed`+`internal_error` / regenerate → `ready`+`internal_error` が書き込まれ、handler が正常終了すること
6. **ラダー整合**: `RETRY_DELAYS_MS` 短縮後も既存のリトライテスト(429→成功、4xx 即 throw)が成立すること(必要なら試行回数の期待値を更新)

**Rationale**: 単体テストは drizzle をモックするため「string が返る」現象自体は再現できない。型の正しさは D1 の型付きカラム select(drizzle のマッピング保証)に委ね、テストは (a) outbound ありパスの完走、(b) クエリ形状、(c) 失敗時状態遷移、を退行検知の対象とする。
