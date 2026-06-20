# Phase 0: Research

**Feature**: 未返信メッセージのバッチ下書き生成
**Branch**: `004-batch-draft-unanswered`
**Date**: 2026-06-20

技術選定と「なぜこの形か」の根拠。既存実装の制約 (001〜003) を踏まえ、最小増分で課題2 を解く方針を確定する。

---

## R-001: 下書きスコープ — メッセージ単位 vs 会話単位

**決定**: **会話単位**に転換する (`ai_drafts.conversation_id` 追加、`message_id` UNIQUE 廃止)。

**背景**: 現行は `ai_drafts.message_id` が UNIQUE で「inbound 1 件 = 下書き 1 件」。連投すると下書きが乱立し、UI は「最新 inbound 紐付き」の 1 件を表示する。

**検討した代替案**:
- **A. メッセージ単位のまま + デバウンスのみ**: webhook はメッセージごとに pending 行を作り続けるため、連投時に「最後の 1 件だけ ready、残りは pending のまま孤児化」する。UI 表示は救えるが、孤児 pending・最新が非テキストのときの欠落・「どの行が正か」の曖昧さが残る。却下。
- **B. 会話単位 (採用)**: 会話に対しアクティブ下書き 1 件。連投・非テキスト・送信後の消化をすべて 1 つの状態機械で表現できる。`message_id` は anchor (生成起点) として nullable 保持。

**根拠**: ユーザーは「最後の自分の返信以降のメッセージをすべて読み取った 1 つの下書き」を求めており、これは本質的に会話状態に対する単一の返信案。会話単位がドメインに忠実で、孤児行や曖昧さを構造的に排除できる。partial unique index で「アクティブ 1 件」を DB レベルで保証できる。

---

## R-002: デバウンス方式 — どこで遅延させるか

**決定**: **SQS `DelaySeconds`** (初期 20 秒) で enqueue を遅延させ、ai-worker 側の coalesce 判定で集約する。

**検討した代替案**:
- **A. アプリ内タイマー / EventBridge スケジューラ**: 新規インフラ・状態管理が必要。YAGNI 違反。
- **B. SQS DelaySeconds (採用)**: 既存キューにパラメータを 1 つ足すだけ。最大 900 秒まで対応。新規インフラゼロ。
- **C. Lambda 内 sleep**: 実行時間課金が無駄。却下。

**coalesce ロジック**: ジョブ payload に `triggerMessageId` を含める。worker は実行時に会話の最新 inbound テキストを再取得し、`triggerMessageId` が最新でなければ **skip** する。連投 K 件 → K 個の遅延ジョブが発火するが、最後のメッセージのジョブ以外はすべて「自分は最新でない」と判定してスキップ → 実生成は 1 回。

**根拠**: at-least-once / 順不同配信の SQS でも、「最新メッセージ起点のジョブだけが生成する」という単純な不変条件で冪等に集約できる。デバウンス秒数は連投の間隔 (数秒) を吸収できる 20 秒を初期値とし、定数で調整可能にする。

**トレードオフ**: 単発メッセージでも最大 20 秒の表示遅延が出る。連投運用の品質を優先し、許容 UX とする。`DRAFT_DEBOUNCE_SECONDS=0` で即時生成に戻せる退避経路を残す。

---

## R-003: 未返信バッチの境界 — 「最後の自分の返信」をどう定義するか

**決定**: **`MAX(messages.timestamp) WHERE direction='outbound'`** を境界とし、それより新しい inbound テキストを未返信バッチとする。専用カラム (`last_outbound_at`) は追加しない。

**検討した代替案**:
- **A. `conversations.last_outbound_at` 列を追加**: 書き込み経路 (send-reply / 将来の echo 取り込み) すべてで更新維持が必要。非正規化の一貫性リスク。
- **B. messages から MAX 集約 (採用)**: 生成時に 1 クエリで導出。常に DB の真実と一致し、将来 echo (outbound) が入れば自動的に正しくなる。

**根拠**: 生成は非同期で頻度も低く、`messages` の (conversation_id, direction, timestamp) 既存インデックスで MAX 集約は安価。非正規化列の維持コストとバグ余地を避ける。**外部送信取り込み Issue が入れば、echo が outbound 行として記録され、この境界が自動的に正しくなる** — 設計上の依存を 1 点に閉じ込められる利点が大きい。

---

## R-004: 未返信バッチと文脈履歴の分離

**決定**: 「文脈履歴」(要約カーソル以降, `RECENT_MESSAGES_CAP=50`) は 003 のまま維持し、その上に「未返信バッチ」(最後の outbound 以降の inbound, `UNANSWERED_CAP=30`) を**回答対象として明示**する節を追加する。

**根拠**: 003 の文脈ウィンドウ (要約 + カーソル以降) は「AI が会話を理解するための材料」。本機能で足りなかったのは「このうちどれに今答えるべきか」の明示。両者は役割が異なるため、プロンプト上で分離する (`buildUserPrompt(history, unanswered)`)。文脈は広く、回答対象は絞る。これで「最後の 1 通にしか答えない」挙動を解消する。

**プロンプト指示**: 未返信節の末尾に「これらは顧客が最後のあなたの返信以降に送った未返信メッセージです。1 通の返信ですべての論点に対応してください」を加える。システムプロンプト合成 (BASE / additional / LANGUAGE_DIRECTIVE) は 003 を不変で踏襲。

---

## R-005: 「会話ごとアクティブ 1 件」の強制方法

**決定**: partial unique index `UNIQUE (conversation_id) WHERE status IN ('pending','ready')` で DB レベルに強制し、enqueue 側は upsert (`ON CONFLICT`) で pending を維持する。

**ライフサイクル**: `pending → ready → (dismissed | superseded)` / `pending → failed`。
- `dismissed`: 運営者が送信または破棄して消化済み。
- `superseded`: 新しいバッチに置き換えられた / 移行で世代落ちした旧アクティブ。
- `failed`: 生成失敗 (非アクティブ。次の新着で新しい pending を作れる)。

**根拠**: 「アクティブ 1 件」は本機能の中核不変条件 (SC-005)。アプリロジックだけでなく DB index で保証することで、SQS 二重配信や競合 upsert があっても破れない。failed をアクティブから外すことで、失敗後も次の新着で自然に再生成できる。

---

## R-006: 既存データ・在庫ジョブの移行

**決定**:
- **データ移行**: `conversation_id` を `messages` から backfill。partial unique index 作成前に、会話ごと最新 1 件以外の active 下書きを `superseded` に倒す (index 作成失敗を防ぐ)。
- **在庫ジョブ移行**: デプロイ時点で SQS に残る旧 `{ messageId }` 形式ジョブを処理できるよう、ai-worker に「messageId → conversationId 解決」のレガシー経路を一時併設する。キューが捌けた後、後続 PR で撤去する。

**根拠**: ダウンタイムなしのローリングデプロイ前提。スキーマ移行と在庫ジョブの両方で後方互換の橋を 1 回だけ架け、過渡期を安全に通す。

---

## R-007: 既存資産の再利用ログ

| 資産 | 再利用方法 |
|---|---|
| draft SQS キュー | そのまま。`SendMessageCommand` に `DelaySeconds` を付けるのみ |
| `withTenant` / `dbAdmin` | ai-worker / server fn のテナント分離をそのまま踏襲 |
| Anthropic client + `callAnthropicWithRetry` | 不変。プロンプト入力だけ拡張 |
| 003 プロンプト合成 (`buildAdditionalSystemPrompt` / BASE / LANGUAGE_DIRECTIVE) | 不変。`buildUserPrompt` のみ拡張 |
| 要約カーソル (`last_summarized_at`) | 文脈ウィンドウ境界として 003 のまま利用 |
| `get-draft-status` ポーリング | 引数を conversationId に変えるのみ |

**新規パッケージ・新規 Lambda・新規キュー・新規 SSM はゼロ。**
