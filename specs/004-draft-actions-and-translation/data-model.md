# Phase 1: Data Model

**Feature**: Draft 操作 UX 強化（再生成・破棄・日本語訳）
**Branch**: `004-draft-actions-and-translation`
**Date**: 2026-05-20
**Storage**: Supabase Postgres（既存）
**ORM**: Drizzle ORM
**Tenancy**: 既存 `tenants` + 全テーブル `tenant_id` + RLS を踏襲。新規テーブルなし、既存テーブルに**カラム追加のみ**。

---

## 変更サマリ

| テーブル | 変更種別 | 追加カラム |
|---|---|---|
| `tenants` | ALTER ADD COLUMN | `translation_enabled` |
| `ai_drafts` | ALTER ADD COLUMN | `lifecycle_status`, `translation_ja`, `translation_status` |

新規テーブルゼロ。新規インデックスゼロ（既存 `ai_drafts_tenant_id_idx` で本機能のクエリはカバーできる。`lifecycle_status` フィルタは `tenant_id` と組み合わせるので追加 index 不要）。RLS ポリシー追加ゼロ（既存ポリシーが新規カラムを自動でカバー）。

---

## Entity: `tenants`（差分）

テナント（オーナー）単位のグローバル設定置き場。spec 003 で `tenants` テーブルの利用が確立済み。今フェーズで「ドラフト日本語訳の表示有無」フラグを追加する。

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `translation_enabled` | `boolean` | `NOT NULL DEFAULT false` | ドラフトの日本語訳を内部表示するかのトグル。Settings 画面から更新。既存テナントは `false` でバックフィル（デフォルト OFF）。|

**インデックス追加なし**。本カラムでの検索は発生せず、テナント単位 SELECT で取れる。

**RLS**: 既存 `tenants` の RLS ポリシー（`id = current_setting('app.tenant_id')`）が新カラムにも適用される。追加ポリシー不要。

**状態遷移**:
- ON → OFF / OFF → ON はオーナー自身が Settings の `updateTranslationToggle` server fn で切り替え。プログラムからの自動遷移は発生しない。

---

## Entity: `ai_drafts`（差分）

AI が生成した返信ドラフト。spec 003 までの実装では「AI 生成進捗を表す `status` 列（`pending`/`ready`/`failed`）」が中心。今フェーズで「ユーザー操作ライフサイクル」と「翻訳結果」を別カラムとして追加する。

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `lifecycle_status` | `varchar(20)` | `NOT NULL DEFAULT 'active'`、`CHECK (lifecycle_status IN ('active', 'discarded', 'superseded'))` | ユーザー操作ライフサイクル。`active` = 未操作（または再生成された新 draft）、`discarded` = ユーザーが破棄、`superseded` = ユーザーが再生成して旧 draft になった。既存行は `active` でバックフィル。|
| `translation_ja` | `text` | NULL 可 | DeepL Free による draft body の日本語訳。NULL は「翻訳未実行」または「翻訳 OFF だった時に生成された draft」。|
| `translation_status` | `varchar(20)` | NULL 可、`CHECK (translation_status IS NULL OR translation_status IN ('ok', 'failed', 'skipped'))` | 翻訳取得の結果。`ok` = 成功、`failed` = API エラー（上限到達含む）、`skipped` = 翻訳 OFF または draft 本体が `failed` で翻訳しなかった、NULL = 翻訳実行前。|

**インデックス追加なし**。`lifecycle_status='active'` のフィルタは既存 `ai_drafts_tenant_id_idx` と組み合わせる Drizzle クエリで処理。会話あたりの draft 行数は MVP 想定で 10 〜 数十のオーダーなので、追加 index は YAGNI。

**RLS**: 既存 `ai_drafts` の RLS ポリシー（tenant_id 一致）が新カラムにも適用される。追加ポリシー不要。

**状態遷移**:

```
lifecycle_status:
  (新規 INSERT) → 'active'
  'active' → 'discarded'    (discardDraft server fn)
  'active' → 'superseded'   (regenerateDraft server fn, 旧 draft 側)
  終端状態: 'discarded' / 'superseded'（戻り遷移なし）
```

```
translation_status:
  NULL                 (INSERT 直後、ai-worker が触る前)
  NULL → 'ok'          (ai-worker: DeepL 成功 + translation_ja 書き込み)
  NULL → 'failed'      (ai-worker: DeepL API エラー)
  NULL → 'skipped'     (ai-worker: translation_enabled=false or draft.status='failed')
  終端状態（再生成では新 draft 行ができるので、上書き遷移は発生しない）
```

---

## Drizzle Schema 差分（TypeScript）

`app/src/server/db/schema.ts` および `ai-worker/src/db/schema.ts`（双方を同期）に以下を追記する。`pgEnum` は使わず `varchar` + CHECK 制約（spec 003 の R-007 方針踏襲）。

```ts
// tenants
export const tenants = pgTable(
  'tenants',
  {
    // ... 既存列 ...
    translationEnabled: boolean('translation_enabled').notNull().default(false),
  },
  (t) => [
    index('tenants_status_idx').on(t.status),
  ],
)

// ai_drafts
export const aiDrafts = pgTable(
  'ai_drafts',
  {
    // ... 既存列 ...
    lifecycleStatus: varchar('lifecycle_status', { length: 20 }).notNull().default('active'),
    translationJa: text('translation_ja'),
    translationStatus: varchar('translation_status', { length: 20 }),
  },
  (t) => [
    index('ai_drafts_tenant_id_idx').on(t.tenantId),
    check(
      'ai_drafts_lifecycle_status_values',
      sql`${t.lifecycleStatus} IN ('active', 'discarded', 'superseded')`,
    ),
    check(
      'ai_drafts_translation_status_values',
      sql`${t.translationStatus} IS NULL OR ${t.translationStatus} IN ('ok', 'failed', 'skipped')`,
    ),
  ],
)
```

---

## Migration: `0003_draft_actions_and_translation.sql`

実行内容（idempotent ではないので、ロールバック SQL も併記）:

```sql
-- Forward migration

ALTER TABLE tenants
  ADD COLUMN translation_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE ai_drafts
  ADD COLUMN lifecycle_status varchar(20) NOT NULL DEFAULT 'active',
  ADD COLUMN translation_ja text,
  ADD COLUMN translation_status varchar(20);

ALTER TABLE ai_drafts
  ADD CONSTRAINT ai_drafts_lifecycle_status_values
    CHECK (lifecycle_status IN ('active', 'discarded', 'superseded'));

ALTER TABLE ai_drafts
  ADD CONSTRAINT ai_drafts_translation_status_values
    CHECK (translation_status IS NULL OR translation_status IN ('ok', 'failed', 'skipped'));

-- 既存行のバックフィル: DEFAULT 'active' によって自動的に 'active' になる
-- 明示しておくと:
-- UPDATE ai_drafts SET lifecycle_status = 'active' WHERE lifecycle_status IS NULL;
-- ↑ NOT NULL DEFAULT 'active' なので NULL は発生しない、明示 UPDATE は不要
```

```sql
-- Rollback

ALTER TABLE ai_drafts
  DROP CONSTRAINT IF EXISTS ai_drafts_translation_status_values,
  DROP CONSTRAINT IF EXISTS ai_drafts_lifecycle_status_values;

ALTER TABLE ai_drafts
  DROP COLUMN IF EXISTS translation_status,
  DROP COLUMN IF EXISTS translation_ja,
  DROP COLUMN IF EXISTS lifecycle_status;

ALTER TABLE tenants
  DROP COLUMN IF EXISTS translation_enabled;
```

ロールバック時に `translation_ja` 列を落とすと翻訳済み draft の翻訳テキストは失われる。これは spec が「翻訳はキャッシュであり消えても OK」と定めている通りの動作。

---

## クエリパターン

### `lifecycle_status='active'` フィルタ（既存 SELECT 全てに追加）

```ts
// 既存 (spec 003 まで):
db.select().from(aiDrafts)
  .where(eq(aiDrafts.messageId, messageId))
  .limit(1)

// spec 004 以降:
db.select().from(aiDrafts)
  .where(and(
    eq(aiDrafts.messageId, messageId),
    eq(aiDrafts.lifecycleStatus, 'active'),
  ))
  .orderBy(desc(aiDrafts.createdAt))
  .limit(1)
```

注: `message_id` は既存スキーマでは `unique()` なので 1 メッセージあたり draft 1 件しか作れない。**再生成時は新しい message_id が必要なのか、それとも message_id の unique 制約を外す必要があるのか、要確認**（D-008 で検討）。

### 破棄

```ts
await db.update(aiDrafts)
  .set({ lifecycleStatus: 'discarded', updatedAt: new Date() })
  .where(and(
    eq(aiDrafts.id, draftId),
    eq(aiDrafts.lifecycleStatus, 'active'), // 楽観ロック相当
  ))
```

### 再生成（旧 draft の supersede）

```ts
await db.update(aiDrafts)
  .set({ lifecycleStatus: 'superseded', updatedAt: new Date() })
  .where(and(
    eq(aiDrafts.id, oldDraftId),
    eq(aiDrafts.lifecycleStatus, 'active'),
  ))
// この後、既存の AI ドラフト enqueue 経路を呼び出し新規 draft 行を INSERT
```

### 翻訳結果書き戻し（ai-worker）

```ts
await db.update(aiDrafts)
  .set({
    translationJa: translationText,
    translationStatus: 'ok',
    updatedAt: new Date(),
  })
  .where(eq(aiDrafts.id, draftId))
```

---

## D-008: `ai_drafts.message_id` の unique 制約

既存スキーマで `messageId` は `unique()`。1 inbound message に対し draft は 1 件しか作れない。spec 004 の再生成は「同じ message に対する 2 つ目以降の draft」を作る必要があるため、この制約と衝突する。

**Decision**: **`message_id` の `UNIQUE` 制約を外す。代わりに `WHERE lifecycle_status='active'` の partial unique index `(message_id) WHERE lifecycle_status='active'` を追加し、「同一 message に active な draft は 1 件のみ」を強制する。**

```sql
-- 既存 unique 制約を破棄
ALTER TABLE ai_drafts DROP CONSTRAINT ai_drafts_message_id_key;

-- 新規 partial unique index
CREATE UNIQUE INDEX ai_drafts_message_id_active_unique
  ON ai_drafts (message_id)
  WHERE lifecycle_status = 'active';
```

**Rationale**:
- spec 004 の FR-009「同一会話で active な draft が同時に複数存在してはならない」を DB レベルで強制
- 履歴（discarded / superseded）は同一 message_id に複数行残せる
- 既存コードで `message_id` の uniqueness に依存している箇所があれば（例: ON CONFLICT (message_id) DO UPDATE）、UPSERT を「lifecycle_status='active' を SELECT → 存在すれば UPDATE / なければ INSERT」に書き換える必要あり

**Alternatives considered**:
- **message_id の unique を維持し、再生成時は旧行を UPDATE する**: ライフサイクル状態の履歴が消える。SC-005「再生成・破棄を含む全てのドラフト履歴が DB に保持される」と矛盾
- **再生成時に新 message_id を発行**: messages テーブルへの不要な書き込みが発生。message_id の意味（顧客の inbound メッセージ ID）と乖離する

---

## まとめ

- 追加カラム: 4 本（`tenants` 1 + `ai_drafts` 3）
- 追加 CHECK 制約: 2 本
- index 入れ替え: 1 件（`message_id` unique → partial unique index）
- 新規テーブル・新規 enum 型・新規 RLS ポリシー: ゼロ
- ロールバック手順を明文化、translation_ja は失われ得る前提を明示
