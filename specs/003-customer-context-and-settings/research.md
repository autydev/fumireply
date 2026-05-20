# Phase 0: Research & Decisions

**Feature**: 会話コンテキストの永続化と設定の階層化
**Branch**: `003-customer-context-and-settings`
**Date**: 2026-05-20

spec で残った [NEEDS CLARIFICATION] は D-001 / D-002 / D-003 として既に解決済 (spec.md の Resolved Decisions セクション参照)。本ドキュメントでは plan を組み立てる過程で発生した追加の技術選定を記録する。

---

## R-001: 要約 Lambda は新規にせず ai-worker を拡張する

**Decision**: 新規 Lambda を作らず、既存 `ai-worker` Lambda にもう 1 つ SQS event source mapping (`ai-summary-queue`) を追加して同じ関数コードで draft と summary を処理する。SQS メッセージ本体に `jobType: 'draft' | 'summary'` を持たせて関数内で分岐する。

**Rationale**:
- ai-worker は既に Anthropic SDK・SSM クライアント・dbAdmin/withTenant パターンを持っており、summary 生成に必要なすべてが揃っている。Lambda 関数とコード package をもう 1 セット用意する正味の追加価値はない
- Lambda 同梱パッケージのサイズは小さく、cold start や RAM フットプリントへの影響は無視できる
- Terraform 追加は SQS キュー 1 本と event source mapping 1 本のみ。新規 IAM ロール・新規 CloudWatch ロググループは不要 (ai-worker のものを共有)
- 002 の plan が確立した「新規 Lambda を作らず既存に乗せる」方針と整合

**Alternatives Considered**:
- 新規 `ai-summary-worker` Lambda を建てる: 完全に責務分離できるが、Terraform モジュール 1 つ・IAM ロール 1 つ・ログ設定・デプロイ pipeline 設定が増える。今フェーズの規模 (single summary call per job) に対して overkill
- 既存 ai-worker の現行キューに jobType 違いで相乗りさせる (キュー 1 本): draft の latency SLO (60 秒) と summary の非同期性をひとつのキューが満たすにはバランスが難しい。draft が滞留すると summary が阻害される / 逆も然り。失敗時 DLQ / 可視性タイムアウトを別個に調整できる方が安全

**Implications**:
- ai-worker の SQS event source は 2 つになる。Lambda の `event.Records` は queue 横断で混在しうるが、AWS Lambda の SQS poller はキュー単位に独立して動作するため互換性問題はない
- 環境変数 `SUMMARY_PIPELINE_ENABLED=false` で event source mapping は残したまま summary job を即座に no-op で消費する経路を入れる (障害時のフォールバックスイッチ)

---

## R-002: 要約カーソルは `last_summarized_at` (timestamptz) を採用

**Decision**: `conversations.last_summarized_at` (timestamptz, nullable) を要約カーソルとして採用する。「last_summarized_message_id (uuid)」ではなく時刻ベースとする。

**Rationale**:
- 「カーソル以降のメッセージ累計文字数」の計算が `SUM(LENGTH(body)) WHERE conversation_id = ? AND timestamp > coalesce(last_summarized_at, '1970-01-01'::timestamptz)` の単純な集約 SQL で書ける
- message_id (UUID) は順序を持たないため、`id > cursor` で「以降」を表現できない。結局 timestamp に依存するなら直接 timestamp をカーソルにするのが自然
- 削除されたメッセージで cursor が orphan になるリスクが回避できる (FK 不要)
- 監査上「いつまで要約に含まれているか」を直接示せる

**Alternatives Considered**:
- `last_summarized_message_id` (uuid FK → messages.id, ON DELETE SET NULL): メッセージ削除で cursor が消えるリスクがあり、`messages` を join しないと「以降」が判定できない。SQL が 1 段複雑
- カウンタ列 (`messages_in_summary` integer): 並列 INSERT で競合する。実装が増える

**Implications**:
- webhook が時刻巻き戻りで out-of-order INSERT する稀ケースで「カーソル以前」とみなされるメッセージが要約に含まれない可能性がある。Meta Messenger Webhook では `messaging.timestamp` が単調増加であることが期待でき、実害は無視できる範囲
- カラム名は `last_summarized_at` 固定。生成完了時の `now()` ではなく、要約に含めた最終メッセージの `timestamp` を保存する (これにより「カーソルより新しい」判定が message 列の `timestamp` と直接比較できる)

---

## R-003: 文字数閾値の初期値は 2,000 文字、上限は別途定数化

**Decision**:
- 要約発火閾値: `SUMMARY_TRIGGER_THRESHOLD_CHARS = 2000`（inbound + outbound 合算、カーソル以降）
- ページカスタムプロンプト上限: `PAGE_PROMPT_MAX = 2000` 文字
- 顧客カスタムプロンプト上限: `CUSTOMER_PROMPT_MAX = 1000` 文字
- 顧客内部メモ上限: `NOTE_MAX = 1000` 文字 (spec で明記されていないが、運用 DoS 防止のため設定)
- 直近メッセージ安全キャップ: `RECENT_MESSAGES_CAP = 50` 件 (要約失敗で cursor 未更新時のコンテキスト爆発を防ぐ)

**Rationale**:
- 2,000 文字は英語/日本語混在で平均 10〜13 件のメッセージに相当 (旧 N=10 件と感覚的に揃う)
- 上限は Claude のコンテキスト窓 (200k) と Haiku のコスト感に対して十分に小さく、ユーザーの自由度を実用範囲で確保しつつトークン爆発を防ぐ
- 安全キャップ 50 件は、平均 200 文字/件で約 10,000 文字。要約失敗継続時でも Claude の処理時間が現実的範囲に収まる

**Alternatives Considered**:
- 閾値をトークン数で計測 (tiktoken 相当): 計算コストが高く、毎回 API 呼び出しか tokenizer 同梱が必要。発火判定の精度は文字数で十分
- 上限を `varchar(N)` で DB 強制: 切り捨てが起きる。`text` + `char_length` CHECK 制約で「保存拒否」する方が UX 上素直

**Implications**:
- 値は `app/src/lib/settings/char-limits.ts` と `ai-worker/src/config.ts` に二重管理ではなく、ai-worker 側は env か共通 SSM から読む案も検討したが、運用変更頻度が低いため**両側に同名定数を埋め込む** (ドリフト時はテストで検出)
- 将来トークン窓のチューニングが必要になれば、`app/src/lib/settings/char-limits.ts` のみ変更してマイグレーション + テストで連動させる

---

## R-004: AI ドラフトプロンプトの 5 段合成順序

**Decision**: ai-worker の draft 経路で、Anthropic API への `system` フィールドを以下の順で連結した単一文字列とし、`cache_control: 'ephemeral'` は最も変化が小さいベース部分のみに付ける。直近メッセージは従来通り `messages: [{ role: 'user', content: userPrompt }]` 側で渡す。

```
[1] BASE_SYSTEM_PROMPT          ← 既存ハードコード (cache_control: ephemeral)
[2] Page Policy (もしあれば)     ← connected_pages.custom_prompt
[3] Customer Tone (もしあれば)   ← conversations.tone_preset (enum → 短い指示文に展開)
[4] Customer Instruction (もしあれば) ← conversations.custom_prompt
[5] Conversation Summary (もしあれば) ← conversations.summary
```

ユーザーターンには「カーソル以降の text メッセージ最大 50 件」のみを生データとして埋める (旧 HISTORY_LIMIT=5 の置き換え)。

**Rationale**:
- Claude の prompt caching は **prefix が同一**であるほどヒット率が高い。最も安定するベースを最初に置き `ephemeral` をマーク、後段の可変部分 (ページ・顧客・要約) はキャッシュ対象外として安全に変動を許す
- ページポリシー → 顧客個別の順は「広い指示 → 狭い指示」の原則に沿う (狭い方が後勝ち)
- 要約は事実情報 (過去会話の文脈) であり、指示ではないため最後に配置して「上記指示に基づき、以下のコンテキストを踏まえて返信せよ」というメンタルモデルを作る

**Alternatives Considered**:
- `system` を配列のまま 5 セグメントを渡し、それぞれに `cache_control` を付ける: Anthropic API の system フィールドは複数 text block を許容するが、ephemeral cache の chained 挙動が複雑化する。MVP では単一連結文字列が安全
- 要約を `messages[0]` の user メッセージとして「これは過去会話の要約です: ...」と渡す: モデルからは指示と区別がつきにくい。`system` 側で「Conversation summary so far:」ラベル付きで投入するのが明確

**Implications**:
- `buildSystemPrompt(parts: { base, pagePrompt?, tone?, customerPrompt?, summary? })` を純粋関数として実装し、unit test で順序と「nullish なら skip」を固定する
- 直近メッセージ生データの抽出は `buildUserPrompt` を改修し、cursor (`last_summarized_at`) と RECENT_MESSAGES_CAP を引数に取る
- `tone_preset` 値 → 指示文の対応表 (例: `friendly` → "Use a friendly, approachable tone." 等) は `ai-worker/src/prompt.ts` の定数とする

---

## R-005: 要約トリガーは webhook と app の両方の INSERT 経路に挿す

**Decision**: 「メッセージ INSERT 後に summary job を enqueue するか判定する」共通ヘルパ `maybeEnqueueSummaryJob(conversationId, tx)` を作り、以下 2 か所から呼ぶ:
1. `webhook/src/handler.ts` の inbound INSERT 成功直後 (現行で AI draft job を enqueue している箇所のすぐ後)
2. `app/src/server/fns/send-reply.fn.ts` (or その相当) の outbound INSERT 成功直後

**Rationale**:
- inbound のみで発火させると、運営者の長い返信がカーソル更新を引き起こさず、要約品質が偏る (片側だけが要約に反映される)
- outbound のみで発火させると、顧客が一方的に長文を投げる典型ケース (見積もり依頼など) で要約されない
- 両側で発火させても、ヘルパ内で同じ閾値判定をするので冪等性は確保される

**Alternatives Considered**:
- ai-worker の draft 経路の末尾で発火: AI ドラフト失敗時に summary job も投げられない/二重投入リスクがある。ドラフトと要約を疎結合に保ちたい
- DB トリガー (Postgres) で発火: SQS への直接送信ができない。pg_notify + 別 worker など複雑化

**Implications**:
- ヘルパは `withTenant` トランザクション内で呼ばれる前提とし、`tx` を引数に取る (RLS フィルタが効いた状態で `SUM(LENGTH(body))` する)
- SQS send 自体はトランザクションの**外**で実行 (失敗してもメッセージ INSERT を取り消さない)。トランザクション commit 後に send する pattern を `summary-trigger.ts` で実装
- send 失敗は warning ログのみ。次回の INSERT で再判定されるため自然に再試行される

---

## R-006: 冪等性 — handler 側で再計算する

**Decision**: summary handler は受け取った `conversationId` に対して**実行時にもう一度** カーソル以降の累計文字数を計算し、閾値未満なら no-op で正常終了する (SQS から消費して完了)。

**Rationale**:
- enqueue が複数走っても (例: 2,000 文字到達と 2,200 文字到達でほぼ同時に 2 メッセージが送られた)、handler 内のしきい値再判定で実質 1 回の Anthropic 呼び出しに収束する
- conversation テーブルに `summary_pending` flag を持たせる方式は、generation 中の同時 INSERT による「pending 解除と更新の競合」を扱う必要があり複雑。**stateless な再判定**が最も robust
- 失敗時のリトライ (DLQ から手動 redrive) も自動的に意味を持つ — その時点でしきい値を超えていればやり直すし、超えていなければ skip する

**Alternatives Considered**:
- `conversations.summary_job_in_flight` flag を持つ: 障害で flag が残るリスク。crash recovery が複雑
- SQS dedup token を会話 ID にする (FIFO キュー使用): FIFO への切替はコストとスループット影響あり。MVP には不要

**Implications**:
- handler は冪等であるためログには「skipped_below_threshold」「executed_summary」「failed」の 3 状態を明確に出す
- summary 生成後の cursor 更新は同一トランザクション内で UPDATE する (生成→保存の間に新着 INSERT があっても、保存される cursor は「Anthropic に渡した最終メッセージの timestamp」固定)

---

## R-007: tone_preset の値域は CHECK 制約で固定する

**Decision**: `conversations.tone_preset` は `varchar(20)` + `CHECK (tone_preset IS NULL OR tone_preset IN ('friendly', 'professional', 'concise'))` とする。pgEnum は使わない。

**Rationale**:
- Drizzle の `pgEnum` は値追加にマイグレーションが必要で、将来トーンを増やす際に運用負担になる
- Postgres CHECK 制約は ALTER TABLE で更新でき、値追加・削除が ENUM より柔軟
- Zod スキーマ (`z.enum(['friendly', 'professional', 'concise'])`) を app 側のシングルソースに置き、CHECK 制約はそれと同期する形でマイグレーションに記述

**Alternatives Considered**:
- `pgEnum`: 厳格だが、値変更時に DB ロックを取る必要がある。MVP の運用柔軟性を優先
- 制約なし (`varchar(20)` のみ): UI バリデーションのみに依存。DB レイヤの defense in depth が薄い

**Implications**:
- マイグレーション SQL に CHECK 制約を含める
- 新トーンを追加するときは Zod スキーマ更新 + マイグレーション (ALTER TABLE ... DROP CONSTRAINT + ADD CONSTRAINT) の 2 ステップ

---

## R-008: 内部メモは AI に渡さない設計をテストで固定

**Decision**: `note` カラムは ai-worker のいずれのプロンプト合成関数の引数にも含めない。`buildSystemPrompt` の引数型定義から `note` を意図的に外し、unit test で「note を含むオブジェクトを渡しても出力に note 内容が現れない」ことを確認する。

**Rationale**:
- FR-016「内部メモを AI プロンプトに含めない」を**設計レベルで**保証する。プロンプト合成関数が note を受け取らなければ、誤って混入する経路がそもそも存在しない
- 将来「note を AI に渡すかをトグルで選べる」を入れる場合 (Assumptions に明記) でも、関数シグネチャに `note?: string` を追加するという明示的な変更が必要になり、ガードが効く

**Alternatives Considered**:
- 関数は note も受け取るが「使わない」: 将来のうっかり混入リスクあり
- DB から SELECT する経路を分ける (note は CustomerPanel 表示用 fn でしか SELECT しない): RLS / 権限視点では同じテナント内なので分けるメリットが薄く、UI 統合が逆に複雑

**Implications**:
- `getConversation.fn.ts` は note を SELECT して UI に返すが、ai-worker は `note` を一切 SELECT しない (ai-worker の `processSummaryJob` / `processDraftJob` 双方で SELECT カラム明示)

---

## R-009: スレッド画面の 3 カラム化と狭幅対応

**Decision**: スレッド画面を 2 カラム (Inbox + Thread) から 3 カラム (Inbox + Thread + CustomerPanel) に変更する。狭幅 (例 < 1280px) では CustomerPanel をデフォルト非表示にし、ヘッダの「人型アイコン」ボタンでトグル表示する。

**Rationale**:
- mock の CustomerPanel は明確にデスクトップ前提 (右カラム固定)
- 一方で MVP 利用者がノート PC / 小型ディスプレイで使うケースもあり、強制 3 カラムは UX を毀損
- 「狭幅で隠す + トグル復活」は Paraglide JS の翻訳キー 1 本追加のみで実装でき、コスト最小

**Alternatives Considered**:
- 常時 3 カラム: 狭幅で thread 本体が圧迫される
- 別ルート `/threads/$id/customer` に分離: ナビゲーション往復が必要で実用性低い

**Implications**:
- `CustomerPanel.tsx` には `display: none` ↔ `flex` を切替える state を持たせる (uncontrolled、breakpoint で初期値が決まる)
- CSS media query で `width < 1280px` 時のデフォルト非表示。`localStorage` で開閉状態を覚える簡易永続化 (DB 不要)

---

## R-010: テストデータ — Anthropic モックは既存パターンを踏襲

**Decision**: 要約・ドラフトの Anthropic 呼び出しは vi.mock の SDK モックで返す。既存 `ai-worker/src/handler.test.ts` のテストパターンをそのまま summary 経路にも適用。

**Rationale**: 既存パターンが安定しており、msw による HTTP モックを追加する必要がない。

**Alternatives Considered**: msw による SDK fetch インターセプト。SDK 内部実装に依存するため非推奨。

**Implications**: 既存テストファイル構成を踏襲。Anthropic API キーは test 環境で `'test-key'` 固定。
