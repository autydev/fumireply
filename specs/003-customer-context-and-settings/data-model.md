# Phase 1: Data Model

**Feature**: 会話コンテキストの永続化と設定の階層化
**Branch**: `003-customer-context-and-settings`
**Date**: 2026-05-20
**Storage**: Supabase Postgres (既存)
**ORM**: Drizzle ORM
**Tenancy**: 既存 `tenants` + 全テーブル `tenant_id` + RLS を踏襲。新規テーブルなし、既存テーブルに**カラム追加のみ**。

---

## 変更サマリ

| テーブル | 変更種別 | 追加カラム |
|---|---|---|
| `connected_pages` | ALTER ADD COLUMN | `custom_prompt` |
| `conversations` | ALTER ADD COLUMN | `summary`, `last_summarized_at`, `tone_preset`, `custom_prompt`, `note` |

新規テーブルゼロ。新規インデックスゼロ (既存の tenant + conversation_id インデックスで本機能のクエリはカバーできる)。RLS ポリシー追加ゼロ (既存ポリシーが新規カラムも自動でカバー)。

---

## Entity: `connected_pages` (差分)

接続済み Facebook ページ。今フェーズで「ページ単位の店舗ポリシー」を保存するカラムを追加する。

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `custom_prompt` | `text` | NULL 可、`CHECK (custom_prompt IS NULL OR char_length(custom_prompt) <= 2000)` | ページ単位のカスタムプロンプト (Settings 画面の textarea から保存)。NULL は未設定。空文字も「未設定」扱いとして UI 側で NULL に正規化。|

**インデックス追加なし**。本カラムでの検索は発生せず、ページレコードを fetch する際の同行 SELECT で取れる。

**RLS**: 既存 `connected_pages` の RLS ポリシー (tenant_id 一致) が自動的に新カラムにも適用される。追加ポリシー不要。

---

## Entity: `conversations` (差分)

顧客との 1 対 1 会話。今フェーズで「会話単位の AI 動作設定 + AI 要約 + 要約カーソル + 内部メモ」を追加する。

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `summary` | `text` | NULL 可 | AI が過去会話から生成した要約本文。NULL は未生成。CustomerPanel に表示される。AI ドラフト生成時にプロンプトに含められる。|
| `last_summarized_at` | `timestamptz` | NULL 可 | 要約カーソル。要約に含められた**最終メッセージ**の `timestamp` を保存する (生成時刻ではない)。次回の閾値判定は `messages.timestamp > last_summarized_at` で範囲を決める。NULL は「まだ一度も要約していない」状態。|
| `tone_preset` | `varchar(20)` | NULL 可、`CHECK (tone_preset IS NULL OR tone_preset IN ('friendly', 'professional', 'concise'))` | トーンプリセット。NULL はトーン指示なし。|
| `custom_prompt` | `text` | NULL 可、`CHECK (custom_prompt IS NULL OR char_length(custom_prompt) <= 1000)` | 顧客個別のカスタム指示。呼び方や特例を含む自由記述。NULL は未設定。|
| `note` | `text` | NULL 可、`CHECK (note IS NULL OR char_length(note) <= 1000)` | 運営者用の内部メモ。**AI プロンプトには含めない** (FR-016)。NULL は未設定。|

**インデックス追加なし**。要約閾値判定は `messages` 側の既存 index (`messages_tenant_id_conversation_id_timestamp_idx`) を使う集約クエリで処理する。

**RLS**: 既存 `conversations` の RLS ポリシー (tenant_id 一致) が自動的に新カラムにも適用される。追加ポリシー不要。

**状態遷移**:
- `summary` / `last_summarized_at` は**常にセットで更新**される。NULL → 非 NULL は要約 Lambda の成功時、非 NULL → 非 NULL (上書き) も要約 Lambda の成功時。手動更新は MVP では発生しない (FR-OOS-006 により手動 UI なし)。
- `tone_preset` / `custom_prompt` / `note` は CustomerPanel の自動保存でのみ更新される。`updateConversationSettings` server fn が部分更新を許容。

---

## Drizzle Schema 差分 (TypeScript)

`app/src/server/db/schema.ts` および `ai-worker/src/db/schema.ts` (双方を同期) に以下を追記する。`pgEnum` は使わず `varchar` + CHECK 制約 (R-007 参照)。

```ts
// connected_pages
export const connectedPages = pgTable(
  'connected_pages',
  {
    // ... 既存列 ...
    customPrompt: text('custom_prompt'),
  },
  (t) => [
    index('connected_pages_tenant_id_idx').on(t.tenantId),
    check(
      'connected_pages_custom_prompt_length',
      sql`${t.customPrompt} IS NULL OR char_length(${t.customPrompt}) <= 2000`,
    ),
  ],
)

// conversations
export const conversations = pgTable(
  'conversations',
  {
    // ... 既存列 ...
    summary: text('summary'),
    lastSummarizedAt: timestamp('last_summarized_at', { withTimezone: true }),
    tonePreset: varchar('tone_preset', { length: 20 }),
    customPrompt: text('custom_prompt'),
    note: text('note'),
  },
  (t) => [
    // ... 既存 indexes / unique ...
    check(
      'conversations_tone_preset_values',
      sql`${t.tonePreset} IS NULL OR ${t.tonePreset} IN ('friendly', 'professional', 'concise')`,
    ),
    check(
      'conversations_custom_prompt_length',
      sql`${t.customPrompt} IS NULL OR char_length(${t.customPrompt}) <= 1000`,
    ),
    check(
      'conversations_note_length',
      sql`${t.note} IS NULL OR char_length(${t.note}) <= 1000`,
    ),
  ],
)
```

注: `check` は Drizzle の制約ヘルパ。`sql` テンプレートで生 SQL を埋め込む。既存 schema.ts は `check` を未利用なので import を追加する。

---

## マイグレーション: `0002_customer_context.sql`

新規マイグレーションファイル 1 本。すべて idempotent (`IF NOT EXISTS`) で書くわけではなく、Drizzle の通常マイグレーションパターン (新規追加) に従う。RLS ポリシーは触らない。

```sql
-- 0002_customer_context.sql

-- connected_pages: ページ単位のカスタムプロンプト
ALTER TABLE "connected_pages"
  ADD COLUMN "custom_prompt" text;

ALTER TABLE "connected_pages"
  ADD CONSTRAINT "connected_pages_custom_prompt_length"
  CHECK ("custom_prompt" IS NULL OR char_length("custom_prompt") <= 2000);

-- conversations: 要約 + カーソル + トーン + カスタム指示 + 内部メモ
ALTER TABLE "conversations"
  ADD COLUMN "summary" text,
  ADD COLUMN "last_summarized_at" timestamptz,
  ADD COLUMN "tone_preset" varchar(20),
  ADD COLUMN "custom_prompt" text,
  ADD COLUMN "note" text;

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_tone_preset_values"
  CHECK ("tone_preset" IS NULL OR "tone_preset" IN ('friendly', 'professional', 'concise'));

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_custom_prompt_length"
  CHECK ("custom_prompt" IS NULL OR char_length("custom_prompt") <= 1000);

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_note_length"
  CHECK ("note" IS NULL OR char_length("note") <= 1000);
```

ロールバック (緊急時):

```sql
ALTER TABLE "conversations"
  DROP CONSTRAINT IF EXISTS "conversations_note_length",
  DROP CONSTRAINT IF EXISTS "conversations_custom_prompt_length",
  DROP CONSTRAINT IF EXISTS "conversations_tone_preset_values",
  DROP COLUMN IF EXISTS "note",
  DROP COLUMN IF EXISTS "custom_prompt",
  DROP COLUMN IF EXISTS "tone_preset",
  DROP COLUMN IF EXISTS "last_summarized_at",
  DROP COLUMN IF EXISTS "summary";

ALTER TABLE "connected_pages"
  DROP CONSTRAINT IF EXISTS "connected_pages_custom_prompt_length",
  DROP COLUMN IF EXISTS "custom_prompt";
```

---

## クエリパターン

### 要約閾値判定 (`maybeEnqueueSummaryJob` 内)

`withTenant` トランザクション内で、対象会話の「カーソル以降の text メッセージ累計文字数」を 1 クエリで取る:

```sql
SELECT COALESCE(SUM(char_length(body)), 0) AS chars_since_cursor
FROM messages
WHERE conversation_id = $1
  AND message_type = 'text'
  AND timestamp > COALESCE(
    (SELECT last_summarized_at FROM conversations WHERE id = $1),
    '1970-01-01'::timestamptz
  );
```

`chars_since_cursor >= 2000` なら summary job を SQS に enqueue。

### 要約 handler のメッセージ取得

`summary.ts` の `processSummaryJob` 内で、対象会話の `summary` + カーソル以降の text メッセージを取得:

```sql
-- 1. conversation row
SELECT id, summary, last_summarized_at FROM conversations WHERE id = $1;

-- 2. cursor 以降のメッセージ (ORDER BY timestamp ASC、安全キャップ 200 件)
SELECT direction, body, timestamp
FROM messages
WHERE conversation_id = $1
  AND message_type = 'text'
  AND timestamp > COALESCE($cursor, '1970-01-01'::timestamptz)
ORDER BY timestamp ASC
LIMIT 200;
```

200 件キャップは要約入力の Anthropic コンテキスト保護。実運用で 2,000 文字 = ~10〜13 件想定なので余裕がある。

### AI ドラフト経路の直近メッセージ取得 (置き換え)

ai-worker `processDraftJob` 内で従来の `LIMIT 5` を以下に置き換え:

```sql
SELECT direction, body, message_type
FROM messages
WHERE conversation_id = $1
  AND message_type = 'text'
  AND timestamp > COALESCE($cursor, '1970-01-01'::timestamptz)
ORDER BY timestamp DESC
LIMIT 50;  -- RECENT_MESSAGES_CAP
-- 取得後にアプリ側で reverse して ASC 順にする
```

カーソルが NULL の場合 (要約未生成) は全 text メッセージ 50 件まで。要約が存在する場合はカーソル以降のみ。

---

## データライフサイクル

- **Meta データ削除コールバック (FR-040)**: 既存の `deletion_log` フローで `conversations` 行が削除されると、本機能の追加列 (`summary`, `last_summarized_at`, `tone_preset`, `custom_prompt`, `note`) も自動的に削除される (行単位削除のため)。追加実装不要。
- **ページ接続解除 (FR-041)**: `connected_pages.is_active = false` または DELETE が走った場合、ページの `custom_prompt` も付随して消える (行単位)。`is_active = false` の場合はカラム値が残るが、AI ドラフト経路は active=true のページのみを fetch するため自然に無効化される。
- **要約の TTL なし**: 古い要約を自動的にクリアする仕組みは今フェーズで作らない。ローリング更新で常に新しい要約に置き換わるため、stale な要約が残るのは「会話に新着がない」ケースのみ (= 内容も古くて当然)。

---

## 後方互換性

- 既存の `getConversation.fn.ts` / inbox 一覧 / threads 一覧は新規カラムを SELECT しなくても動作する。UI 表示が必要なクエリだけ SELECT を拡張する
- 既存 ai-worker は今回の handler.ts 改修で「カーソル NULL = 従来通り直近 5 件」の経路は廃止し、「カーソル NULL = 直近 50 件まで」に変わる。生成プロンプトは長くなるが、要約生成までの過渡期を含めて品質が落ちないことを期待
- SC-007「既存の AI ドラフト生成機能について、本機能導入後も回帰がなく、カスタムプロンプト / 顧客設定 / 要約が全て null の状態でも従来通りドラフトが生成される」を、ai-worker のテストで明示的にカバーする (handler.test.ts の既存ケースは全列 NULL でグリーンであるべき)
