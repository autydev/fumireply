# Contract: 送信側メディア添付パイプライン

**Feature**: 010-outbound-media | **Date**: 2026-07-20 | **Input**: [research.md](../research.md), [data-model.md](../data-model.md)

実装が守るべき境界契約。変更する場合は本ファイルを先に更新する。

## 1. 定数 (`app/src/server/services/media-upload.ts` に集約)

```ts
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
export const MAX_ATTACHMENT_BYTES = 26_214_400        // 25 MiB — 009 と同値
export const UPLOAD_URL_EXPIRES_IN = 300              // presigned PUT の有効秒数
export const SEND_TOTAL_BUDGET_MS = 22_000            // sendReplyFn 全体の時間予算 (Lambda 30s - 余裕)
export const SEND_MIN_ATTEMPT_MS = 5_000              // 残余がこれ未満なら次パーツは Meta を呼ばず failed
```

クライアント (ReplyForm) は同値のバリデーションを行うが、正は常にサーバー側。

## 2. `createUploadUrlFn` (新規 server fn)

`app/src/routes/(app)/threads/$id/-lib/create-upload-url.fn.ts` / 実体 `create-upload-url.server.ts`

**Input** (zod):
```ts
{ conversationId: string(uuid), contentType: enum(ALLOWED_IMAGE_TYPES), sizeBytes: number(int, 1..MAX_ATTACHMENT_BYTES) }
```

**振る舞い**:
1. `authMiddleware` + `withTenant` で会話がテナントに属することを検証 (存在しなければ `not_found`)
2. 24h ウィンドウを検証 (`lastInboundAt` — 期限外は `outside_window`)。アップロード時点でも弾いて無駄なアップロードを防ぐ
3. `MEDIA_BUCKET_NAME` 未設定なら `not_configured`
4. s3Key = `{tenantId}/{conversationId}/outbound/{crypto.randomUUID()}/0` を採番
5. presigned PUT URL を発行 (`ContentType` を署名に含める、有効 `UPLOAD_URL_EXPIRES_IN` 秒)
6. `outbound_upload_url_issued` を info ログ

**Output**:
```ts
{ ok: true, s3Key: string, uploadUrl: string }
| { ok: false, error: 'not_found' | 'outside_window' | 'not_configured' | 'validation_failed' }
```

**禁止事項**: クライアント指定の任意キーを受けない。キーはサーバー採番のみ。

## 3. ブラウザ → S3 アップロード

- `fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': contentType }, body: file })`
- ContentType が署名と不一致なら S3 が 403 → UI はアップロード失敗として再選択を促す
- presigned PUT はサイズを強制しない。**サイズの最終強制は §4-3 の HeadObject** (client 検証は UX 用の一次防御)

## 4. `sendReplyFn` (拡張)

**Input** (zod) — 後方互換の拡張:
```ts
{
  conversationId: string(uuid),
  body: string(trim),                       // 変更: min(1) を外し、body か attachment の少なくとも一方を必須に (refine)
  attachment?: { s3Key: string }            // 追加 (省略時は従来のテキスト送信と完全同一挙動)
}
```

**振る舞い** (attachment あり時):
1. TX1 (既存): 24h ウィンドウ検証 + page token 取得 — 従来どおり 1 回だけ
2. **s3Key 検証**: 正規表現 `^{tenantId}/{conversationId}/outbound/[0-9a-f-]{36}/0$` (tenantId は auth 由来、conversationId は入力値) に一致しなければ `validation_failed` + `outbound_attachment_key_rejected` を warn ログ (FR-010)
3. **HeadObject 検証**: 存在しない → `validation_failed`。ContentType が allowlist 外 or ContentLength > MAX → `validation_failed` (オブジェクトは残置)
4. **パーツ逐次送信**: parts = [text (body 非空時), image] を順に処理。各パーツで:
   a. pending 行 INSERT (image パーツは `messageType:'image'`, `body:''`, `attachments:[{index:0, type:'image', s3Key, contentType, sizeBytes}]` — Head の値を記録)
   b. 時間予算チェック: 経過 > SEND_TOTAL_BUDGET_MS - SEND_MIN_ATTEMPT_MS なら Meta を呼ばず `failed` (`sendError:'timeout'`, reason `budget_exceeded` をログ)
   c. Meta 送信 (image は §5 のペイロード)。presigned GET は既存 `getAttachmentUrl(s3Key)` で取得
   d. TX2 (既存): sent + metaMessageId / failed + sendError。mid unique 衝突時の echo claim 回復も既存どおりパーツ単位で適用
5. 下書き dismiss / `lastMessageAt` 更新は**最後に成功したパーツ**の TX2 で 1 回 (全パーツ失敗なら実行しない — 既存の失敗時挙動と同じ)

**Output** — 後方互換の拡張:
```ts
{
  ok: boolean,                              // 全パーツ成功時のみ true (既存クライアントの分岐互換)
  error?: SendError,                        // ok=false 時、最初に失敗したパーツのエラー (既存互換)
  parts: Array<{ kind: 'text' | 'image', ok: boolean, error?: SendError }>  // 追加: 部分失敗の内訳 (US2-3)
}
```

**順序保証**: text パーツの sent/failed 確定前に image パーツの送信を開始しない。1 通目の失敗で 2 通目をスキップしない (independent — research D4)。

## 5. Meta Send API ペイロード契約 (`messenger.ts` 拡張)

`sendMessengerReply` を判別 union 入力に拡張 (または `sendMessengerImage` を追加):

```json
{
  "recipient": { "id": "<PSID>" },
  "messaging_type": "RESPONSE",
  "message": { "attachment": { "type": "image", "payload": { "url": "<presigned GET URL>", "is_reusable": false } } }
}
```

- エンドポイント・タイムアウト (5s)・リトライ (3 試行 500/1500/4500ms)・エラーマッピングはテキスト送信と共通
- レスポンスの `message_id` 取得も共通

## 6. 表示契約 (変更なし — 回帰テストで固定)

- `get-conversation.fn.ts`: outbound 行の attachments も受信側と同じ `toUrl` (プレフィックス検証 + presign) を通る。**コード変更は `mediaUploadEnabled` フラグ追加のみ**
- `ThreadMessages.tsx`: outbound バブルは既に `AttachmentList` を描画するため変更なし
- echo upsert (webhook): `set: { sendStatus }` のみ — 送信時に書いた attachments を上書きしない。**webhook のコード変更なし**

## 7. UI 契約 (ReplyForm)

- 添付ボタンは `mediaUploadEnabled && !isWindowClosed` のときのみ活性
- 状態機械: `idle → picked(client検証済み) → uploading → ready → sending → done/failed`
- client 検証: ALLOWED_IMAGE_TYPES / MAX_ATTACHMENT_BYTES 外は選択時に即エラー表示 (i18n)、アップロードに進まない
- プレビュー: `URL.createObjectURL(file)` によるローカルサムネイル + 取り消しボタン (revoke を忘れない)
- 送信成功後: body / 添付状態をクリアし `router.invalidate()` (既存挙動)
- 部分失敗: `parts` を見て「テキストは送信済み、画像は失敗」を i18n で表示。失敗パーツは添付を保持したまま再送可能 (同じ s3Key で再度 sendReplyFn)
- i18n キー (ja/en): `thread_attach_image`, `thread_attach_remove`, `thread_attach_invalid_type`, `thread_attach_too_large`, `thread_attach_upload_failed`, `thread_attach_partial_failure` (最終キー名は実装時に既存規約へ揃える)

## 8. 構造化ログイベント

| event | level | フィールド |
|---|---|---|
| `outbound_upload_url_issued` | info | tenantId, conversationId, s3Key, contentType, sizeBytes |
| `outbound_attachment_send_failed` | warn | tenantId, conversationId, messageId, s3Key, reason |
| `outbound_attachment_key_rejected` | warn | tenantId, conversationId, presentedKey |

`reason` ∈ `meta_error | timeout | budget_exceeded | head_validation_failed`。既存の `event=` JSON 形式・命名規約 (009 `attachment_*` と対を成す `outbound_*`) に従う。

## 9. Terraform / IAM 差分

- `modules/app-lambda/main.tf`: IAM statement `S3GetMediaObject` を拡張または並置 — **`s3:PutObject` を `${media_bucket_arn}/*` に追加** (presigned PUT の署名者権限)。HeadObject は既存 `s3:GetObject` でカバー
- `envs/review/main.tf`: **`aws_s3_bucket_cors_configuration.media` を新設**:
  ```hcl
  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = ["https://${var.domain_name}"]   # 開発用 origin は変数で追加可能に
    allowed_headers = ["content-type"]
    max_age_seconds = 3600
  }
  ```
- webhook モジュール・SSM・Meta App 設定の変更なし

## 10. クライアント互換性

- `sendReplyFn` の `attachment` 省略時は入出力とも従来と完全一致 (既存テストが無変更で通ること)
- `getConversationFn` レスポンスへの `mediaUploadEnabled` 追加は additive (既存フィールド不変)
- DB 値パターンの追加 (outbound + attachments) は 009 の表示コード・AI worker (テキストのみ参照)・未返信バッチ (direction/timestamp のみ参照) に非干渉 (FR-015)
