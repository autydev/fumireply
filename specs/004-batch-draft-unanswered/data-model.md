# Phase 1: Data Model

**Feature**: 未返信メッセージのバッチ下書き生成
**Branch**: `004-batch-draft-unanswered`
**Date**: 2026-06-20
**Storage**: Supabase Postgres (既存)
**ORM**: Drizzle ORM
**Tenancy**: 既存 `tenants` + 全テーブル `tenant_id` + RLS を踏襲。新規テーブルなし。`ai_drafts` に**カラム追加 + 制約付け替え + データ移行**のみ。

---

## 変更サマリ

| テーブル | 変更種別 | 内容 |
|---|---|---|
| `ai_drafts` | ALTER | `conversation_id` 追加 (NOT NULL, FK)、`message_id` の UNIQUE 廃止 + nullable 化、partial unique index 追加、`status` 値域拡張 (`dismissed`/`superseded`) |

新規テーブルゼロ。`conversations` / `messages` のスキーマ変更ゼロ (要約カーソルや outbound 境界は既存列から導出)。RLS ポリシー追加ゼロ。

---

## Entity: `ai_drafts` (差分)

AI 下書き。本フェーズで「メッセージ単位」から「会話単位 (アクティブ 1 件)」へ転換する。

| Column | Type | 変更 | Notes |
|--------|------|------|-------|
| `conversation_id` | `uuid` | **追加** NOT NULL, `REFERENCES conversations(id) ON DELETE CASCADE` | 会話スコープの鍵。下書きはこの会話のアクティブ状態を表す。|
| `message_id` | `uuid` | **UNIQUE 廃止 + nullable 化** (`REFERENCES messages(id) ON DELETE SET NULL`) | 生成起点 (anchor) の inbound メッセージ。参照情報として保持。会話単位化により一意ではなくなる。|
| `status` | `varchar(20)` | **値域拡張** | `pending` / `ready` / `failed` / `dismissed`(送信・破棄で消化) / `superseded`(新バッチ・移行で世代落ち)。**アクティブ = {pending, ready}**。|

**ライフサイクル (状態遷移)**:

```
            inbound 受信 (webhook upsert)
                    │
                    ▼
                pending ──(coalesce skip 以外で生成成功)──▶ ready
                    │                                        │
        (生成失敗)  │                          (運営者 送信/破棄) │
                    ▼                                        ▼
                 failed                                  dismissed
                    │                                        ▲
        (未返信バッチが空)──────────────────────────────────┘
                    │
        (新バッチが旧 active を置換 / 移行)
                    ▼
               superseded
```

- `pending → ready`: 生成成功 (会話アクティブ下書き行へ書込)。
- `pending/ready → dismissed`: 運営者が送信または破棄。または未返信バッチが空で空振り回避。
- `pending/ready → superseded`: 新しい inbound バッチがアクティブを置き換える際、または移行で会話あたり 1 件に整理する際。
- `* → failed`: 生成失敗。アクティブ扱いせず、次の新着で新 pending を作れる。

**Partial Unique Index** (中核制約):

```sql
CREATE UNIQUE INDEX ai_drafts_active_per_conversation
  ON ai_drafts (conversation_id)
  WHERE status IN ('pending', 'ready');
```

会話ごとにアクティブ下書きは最大 1 件 (SC-005)。SQS 二重配信や競合 upsert でも破れない。

**追加インデックス**: 上記 partial unique index のみ。会話アクティブ下書きの取得 (`WHERE conversation_id = $1 AND status IN ('pending','ready')`) はこの index でカバーされる。既存 `ai_drafts_tenant_id_idx` は維持。

**RLS**: 既存 `ai_drafts` の tenant_id RLS が新カラムにも自動適用。追加ポリシー不要。

---

## Drizzle Schema 差分 (TypeScript)

`app/src/server/db/schema.ts` / `ai-worker/src/db/schema.ts` / `webhook/src/db/schema.ts` の 3 箇所を同期。

```ts
export const aiDrafts = pgTable(
  'ai_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id')          // 追加
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')                    // UNIQUE 廃止 + nullable 化
      .references(() => messages.id, { onDelete: 'set null' }),
    status: varchar('status', { length: 20 }).notNull(),
    body: text('body'),
    model: varchar('model', { length: 64 }),
    error: text('error'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    latencyMs: integer('latency_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_drafts_tenant_id_idx').on(t.tenantId),
    uniqueIndex('ai_drafts_active_per_conversation')
      .on(t.conversationId)
      .where(sql`status IN ('pending', 'ready')`),
  ],
)
```

注: `uniqueIndex(...).where(...)` の partial index 表現は Drizzle のバージョンに依存するため、対応していなければマイグレーション SQL 側で `CREATE UNIQUE INDEX ... WHERE ...` を正とし、schema 側はコメントで意図を残す。`status` の CHECK 制約は既存に存在しないため新設しない (値域はアプリ層で管理。導入する場合は別途検討)。

---

## マイグレーション: `0003_conversation_scoped_drafts.sql`

順序が重要。**(1) 列追加 → (2) backfill → (3) NOT NULL/FK 化 → (4) 旧 UNIQUE 廃止 → (5) 重複 active の整理 → (6) partial unique index** の順で、index 作成失敗を避ける。

```sql
-- 0003_conversation_scoped_drafts.sql

-- (1) conversation_id 追加 (まず nullable で)
ALTER TABLE "ai_drafts" ADD COLUMN "conversation_id" uuid;

-- (2) 既存行を messages から backfill
UPDATE "ai_drafts" d
SET "conversation_id" = m."conversation_id"
FROM "messages" m
WHERE d."message_id" = m."id"
  AND d."conversation_id" IS NULL;

-- backfill できない孤児下書き (message 削除済み等) は安全側に倒す
UPDATE "ai_drafts"
SET "status" = 'superseded'
WHERE "conversation_id" IS NULL;

-- それでも残る NULL は移行対象外として除去 (孤児・参照不能)
DELETE FROM "ai_drafts" WHERE "conversation_id" IS NULL;

-- (3) NOT NULL + FK 化
ALTER TABLE "ai_drafts" ALTER COLUMN "conversation_id" SET NOT NULL;
ALTER TABLE "ai_drafts"
  ADD CONSTRAINT "ai_drafts_conversation_id_fk"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;

-- (4) message_id の UNIQUE を廃止し nullable 化
ALTER TABLE "ai_drafts" DROP CONSTRAINT IF EXISTS "ai_drafts_message_id_unique";
ALTER TABLE "ai_drafts" DROP CONSTRAINT IF EXISTS "ai_drafts_message_id_key";
ALTER TABLE "ai_drafts" ALTER COLUMN "message_id" DROP NOT NULL;
-- 既存 FK が ON DELETE CASCADE の場合は SET NULL に張り替え (任意・anchor 保持のため)
ALTER TABLE "ai_drafts" DROP CONSTRAINT IF EXISTS "ai_drafts_message_id_messages_id_fk";
ALTER TABLE "ai_drafts"
  ADD CONSTRAINT "ai_drafts_message_id_fk"
  FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL;

-- (5) 会話ごと最新 1 件以外の active 下書きを superseded に整理 (partial unique index の前提)
WITH ranked AS (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "conversation_id"
           ORDER BY "created_at" DESC, "id" DESC
         ) AS rn
  FROM "ai_drafts"
  WHERE "status" IN ('pending', 'ready')
)
UPDATE "ai_drafts"
SET "status" = 'superseded'
WHERE "id" IN (SELECT "id" FROM ranked WHERE rn > 1);

-- (6) partial unique index: 会話ごとアクティブ 1 件
CREATE UNIQUE INDEX "ai_drafts_active_per_conversation"
  ON "ai_drafts" ("conversation_id")
  WHERE "status" IN ('pending', 'ready');
```

### ロールバック (緊急時)

```sql
DROP INDEX IF EXISTS "ai_drafts_active_per_conversation";
ALTER TABLE "ai_drafts" DROP CONSTRAINT IF EXISTS "ai_drafts_message_id_fk";
ALTER TABLE "ai_drafts" DROP CONSTRAINT IF EXISTS "ai_drafts_conversation_id_fk";
ALTER TABLE "ai_drafts" DROP COLUMN IF EXISTS "conversation_id";
-- message_id の UNIQUE / NOT NULL を戻す場合は、重複 message_id がないことを確認してから:
-- ALTER TABLE "ai_drafts" ALTER COLUMN "message_id" SET NOT NULL;
-- ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_message_id_unique" UNIQUE ("message_id");
```

注: `status` の `dismissed`/`superseded` は CHECK を新設しないため、ロールバックで値域を戻す処理は不要 (varchar のまま)。

---

## クエリパターン

### enqueue 側 (webhook): アクティブ下書きの upsert

inbound テキスト受信時、会話のアクティブ下書きを pending に。partial unique index に対する upsert:

```sql
INSERT INTO ai_drafts (tenant_id, conversation_id, message_id, status, created_at, updated_at)
VALUES ($tenant, $conversation, $message, 'pending', now(), now())
ON CONFLICT (conversation_id) WHERE status IN ('pending','ready')
DO UPDATE SET status = 'pending', message_id = EXCLUDED.message_id, updated_at = now();
```

(Drizzle の `onConflict` で partial index をターゲットにできない場合は、`UPDATE ... WHERE conversation_id=$1 AND status IN ('pending','ready')` → 影響行 0 なら `INSERT` のフォールバックで実装する。)

### worker 側: coalesce 判定 (最新 inbound テキスト)

```sql
SELECT id, timestamp
FROM messages
WHERE conversation_id = $1 AND direction = 'inbound' AND message_type = 'text'
ORDER BY timestamp DESC, id DESC
LIMIT 1;
-- この id が job.triggerMessageId と異なれば skip (後続ジョブが処理)
```

### worker 側: 未返信バッチの境界 (最後の outbound timestamp)

```sql
SELECT MAX(timestamp) AS last_outbound_ts
FROM messages
WHERE conversation_id = $1 AND direction = 'outbound';
-- NULL なら会話の全 inbound テキストが未返信
```

### worker 側: 未返信バッチ抽出

```sql
SELECT body, timestamp
FROM messages
WHERE conversation_id = $1
  AND direction = 'inbound'
  AND message_type = 'text'
  AND timestamp > COALESCE($last_outbound_ts, '1970-01-01'::timestamptz)
ORDER BY timestamp ASC
LIMIT 30;  -- UNANSWERED_CAP
-- 0 件なら下書きを dismissed にして終了 (空振り回避)
```

### worker 側: 文脈履歴 (003 踏襲, 変更なし)

```sql
SELECT direction, body, message_type
FROM messages
WHERE conversation_id = $1
  AND message_type = 'text'
  AND timestamp > COALESCE($cursor, '1970-01-01'::timestamptz)  -- last_summarized_at
ORDER BY timestamp DESC
LIMIT 50;  -- RECENT_MESSAGES_CAP, 取得後 reverse
```

### worker 側: 生成結果の書込 (会話アクティブ下書きへ)

```sql
UPDATE ai_drafts
SET status = $status, body = $body, model = $model,
    prompt_tokens = $pt, completion_tokens = $ct, latency_ms = $lat, updated_at = now()
WHERE conversation_id = $1 AND status = 'pending';
```

---

## データライフサイクル

- **Meta データ削除コールバック**: `conversations` 行削除時、`ai_drafts.conversation_id` の `ON DELETE CASCADE` で下書きも自動削除。`messages` 行削除時は `message_id` が `SET NULL` になるだけで下書き本体は残る (anchor を失っても会話単位で意味を保つ)。
- **送信・破棄**: アクティブ下書きを `dismissed` に。物理削除はしない (監査・メトリクス用に残す)。
- **移行**: 旧メッセージ単位下書きは会話ごと最新 1 件を残し、他は `superseded`。

---

## 後方互換性

- **在庫 SQS ジョブ**: 旧 `{ messageId }` 形式が残っていても、ai-worker は messageId → conversationId を解決して会話スコープ処理にフォールバックする (contract 参照)。キュー消化後に後続 PR で撤去。
- **UI**: `get-conversation.fn.ts` の `latest_draft` 取得を会話アクティブ下書きに変えるのみ。返却フィールド形 (`{ status, body }`) は維持し、表示側の破壊的変更を避ける。
- **回帰保証**: 単発メッセージ 1 件のケースで、従来同等の下書きが 1 件生成されること (SC-003) を ai-worker テストで固定。
