# Data Model: 受信画像・添付メディアの永続保存とスレッド表示 (009)

## 変更サマリ

| 対象 | 変更 |
|---|---|
| `messages` | `attachments jsonb` 列を 1 本追加 (nullable)。既存列・制約・インデックスは不変 |
| 新テーブル | なし |
| RLS | 変更なし (既存の `messages` 行ポリシーが新列も保護) |
| S3 | 新規バケット `${name_prefix}-media`。キー `{tenantId}/{conversationId}/{sanitized_mid}/{index}` |
| レガシー移行 | `UPDATE messages SET body='' WHERE message_type='image' AND body LIKE 'http%'` (FR-004a) |

マイグレーションは app 側 (`app/src/server/db/migrations/0004_*.sql`) の 1 本。`webhook/src/db/schema.ts` の複製スキーマも手動同期する (両ファイルが同一 DB を指す現行方式を維持)。

## `messages.attachments` スキーマ

```ts
// app/src/server/db/schema.ts / webhook/src/db/schema.ts (両方に同一定義)
attachments: jsonb('attachments').$type<MessageAttachment[] | null>(),
```

```ts
interface MessageAttachment {
  index: number            // メッセージ内の添付順序 (0 始まり)
  type: 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'unknown'
  s3Key: string | null     // 保存成功時のみ。null = 取得不可 or 保存対象外 (sticker/unknown)
  contentType?: string     // ダウンロード時の Content-Type (保存成功時のみ)
  sizeBytes?: number       // 保存サイズ (保存成功時のみ)
}
```

### 値のパターンと意味

| `attachments` の値 | 意味 | UI 表示 |
|---|---|---|
| `NULL` | 添付なし (テキスト等) / 本機能以前のレガシー行 | `message_type` が非 text ならプレースホルダ/ラベルを導出 |
| `[]` は作らない | 添付ゼロなら `NULL` に統一 (曖昧さ排除) | — |
| `[{ type:'image', s3Key:'…' }]` | 保存済み画像 | presigned URL で `<img>` 表示 |
| `[{ type:'image', s3Key:null }]` | 画像 (取得不可: DL 失敗/超過) | 「画像 (取得不可)」プレースホルダ |
| `[{ type:'video'\|'audio'\|'file', s3Key:'…' }]` | 保存済み (本リリースでは再生/DL 提供なし) | 種別ラベル |
| `[{ type:'sticker'\|'unknown', s3Key:null }]` | 保存対象外 | 種別ラベル |
| 複数要素 | 複数添付 (index 順) | 全件を順に表示 |

### `message_type` 列との関係

- `message_type` は従来どおり「メッセージの粗い種別」: `text` / `image` / `sticker` に **`video` / `audio` / `file`** が加わる (`unknown` は既存)。varchar(20) のまま、CHECK 制約なし (現行踏襲)
- テキストなしの場合、`message_type` = 先頭添付 (`index 0`) の type
- テキスト + 添付共存時は `message_type='text'` で `attachments` に添付を記録

## 状態遷移 (受信 1 添付あたり)

```
受信 (payload.url あり, type ∈ {image,video,audio,file})
  ├─ Content-Length > 25MB ──────────────→ s3Key=null  [attachment_skipped_oversize]
  ├─ DL 成功 (≤25MB) → PutObject 成功 ───→ s3Key=キー  [attachment_stored]
  ├─ DL/PUT 失敗 → リトライ ×2 → 失敗 ──→ s3Key=null  [attachment_download_failed]
  └─ MEDIA_BUCKET_NAME 未設定 ──────────→ s3Key=null  [attachment_download_failed (bucket_not_configured)]

受信 (type ∈ {sticker, unknown} または url なし)
  └─ ダウンロードせず記録のみ ──────────→ s3Key=null
```

保存後の状態変化はない (immutable)。非同期の再取得・更新経路は存在しない (spec Q2)。

## 不変条件

1. **メッセージ INSERT は添付の成否と独立に成功する** (FR-003)。attachments の確定はメッセージ INSERT と同一トランザクション内 (ダウンロードは tx 外で先行実行し、結果を値として INSERT)
2. **`body` に URL は入らない** (FR-004)。`body` は text のときのみ非空
3. **`s3Key` は必ず `{自テナント ID}/` で始まる** (FR-010)。presign 時に他テナントのキーが混入する経路は RLS 選択 + キー生成規約の二重で防ぐ
4. **同一 mid の再配信で行も S3 オブジェクトも増えない**: 行は `metaMessageId` UNIQUE + `onConflictDoNothing`/UPSERT、S3 は決定的キーへの同内容再 PUT
5. **レガシー行 (`attachments IS NULL` かつ `message_type` 非 text) は必ずプレースホルダ/ラベル表示になる** — 旧形式 (body=URL) は移行で消滅しており、UI に旧形式判定は存在しない (FR-004a)

## マイグレーション `0004_*.sql`

```sql
ALTER TABLE "messages" ADD COLUMN "attachments" jsonb;
--> statement-breakpoint
-- 009 FR-004a: 失効済み CDN URL を body に保存していた旧 inbound 画像を新形式へ統一
UPDATE "messages" SET "body" = '' WHERE "message_type" = 'image' AND "body" LIKE 'http%';
```

- 生成: `cd app && npx drizzle-kit generate` (列追加分) → UPDATE 文を同ファイルへ手動追記 (0001_rls.sql に手書き前例)
- 適用: `npm run db:migrate`
- ロールバック考慮: 列追加は旧コードに無害 (SELECT * 以外未参照)。UPDATE は不可逆だが対象は失効 URL 文字列のみ (spec Q3 で承認)

## サーバ関数の返却型 (app 内部契約)

```ts
// MessageWithDraft (get-conversation.fn.ts) に追加
attachments: {
  index: number
  type: 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'unknown'
  url: string | null   // presigned GET URL (1h)。s3Key が null / バケット未設定なら null
}[]                     // DB 値 NULL → [] に正規化して返す
```

`s3Key` そのものはクライアントへ渡さない (内部構造の露出防止)。
