# Contract: 送信側メディア添付パイプライン

**Feature**: 010-outbound-media | **Date**: 2026-07-20 | **Input**: [research.md](../research.md), [data-model.md](../data-model.md)

実装が守るべき境界契約。変更する場合は本ファイルを先に更新する。

## 1. 定数 (`app/src/server/services/media-upload.ts` に集約)

```ts
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
export const MAX_ATTACHMENT_BYTES = 26_214_400        // 25 MiB — 009 と同値
export const UPLOAD_URL_EXPIRES_IN = 300              // presigned PUT の有効秒数
export const SEND_TOTAL_BUDGET_MS = 25_000            // 2 通の Meta 呼び出し合計の上限 (Lambda 30s - オーバーヘッド ~5s)
export const SEND_MIN_ATTEMPT_MS = 1_500             // sendMessengerReply: 残余がこれ未満なら試行を打ち切り timeout を返す
```

クライアント (ReplyForm) は同値のバリデーションを行うが、正は常にサーバー側。定数は実測リトライラダー (research D3: 1 通最悪 ~17s) から導出。`SEND_TOTAL_BUDGET_MS` は 009 の `MEDIA_TOTAL_BUDGET_MS` と同じ「共有 deadline」方式で使う (§4-4 / §5)。

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
5. presigned PUT URL を発行。**`ContentType` と `ContentLength` (= 入力 `sizeBytes`) を `PutObjectCommand` に含めて署名**する (research D1)。これで型とサイズを S3 がアップロード時点で強制する
6. `outbound_upload_url_issued` を info ログ

**Output**:
```ts
{ ok: true, s3Key: string, uploadUrl: string }
| { ok: false, error: 'not_found' | 'outside_window' | 'not_configured' | 'validation_failed' }
```

**禁止事項**: クライアント指定の任意キーを受けない。キーはサーバー採番のみ。

## 3. ブラウザ → S3 アップロード

- `fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': contentType }, body: file })`
- **サイズは S3 が署名済み `ContentLength` で強制**する: ブラウザはボディ実バイト数から `Content-Length` を自動設定するため、申告 `sizeBytes` と実バイト数が食い違えば S3 が 403 で拒否する (research D1 の悪用対策)。ContentType 不一致も同様に 403
- 403 / ネットワーク失敗時、UI はアップロード失敗として扱い、**新しいアップロード URL を `createUploadUrlFn` から採番し直して**再試行する (古い URL/キーは 300 秒で失効。使い回さない — §7)
- 送信実行時の `HeadObject` (§4-3) は「アップロード済みオブジェクトが送信時点でも規約に合致するか」の最終確認であり、サイズ強制の主役は本節の署名済み `ContentLength`

## 4. `sendReplyFn` (拡張)

**Input** (zod) — 後方互換の拡張:
```ts
{
  conversationId: string(uuid),
  body: string(trim),                       // 変更: min(1) を外し、body か attachment の少なくとも一方を必須に (refine)
  attachment?: { s3Key: string }            // 追加 (省略時は従来のテキスト送信と完全同一挙動)
}
```

> **実装上の前提 (レビュー M-1)**: 本番の送信ロジックは現状 `send-reply.fn.ts` にインライン実装され、`send-reply.server.ts` の `handleSendReply` は**テスト専用の別実装**で本番からは呼ばれていない (`fn.ts` は定数と型しか import しない)。パーツ化はこの**両ファイルを書き換える**。可能なら共有のパーツ処理ヘルパー (例: `processSendPart(tx, ..., deadlineMs)`) に括り出し、`fn.ts`/テストの二重実装を収束させる。

**振る舞い** (attachment あり時):
1. TX1 (既存): 24h ウィンドウ検証 + page token 取得 — 従来どおり 1 回だけ。`MEDIA_BUCKET_NAME` 未設定なら `validation_failed` で終了 (UI は `mediaUploadEnabled=false` で送信させないが、迂回への防御。既存 union に新値を足さないため `validation_failed` を流用 — INV-4)
2. **s3Key 検証**: 正規表現 `^{tenantId}/{conversationId}/outbound/[0-9a-f-]{36}/0$` (tenantId は auth 由来、conversationId は入力値) に一致しなければ `validation_failed` + `outbound_attachment_key_rejected` を warn ログ (FR-010)
3. **HeadObject 検証**: 存在しない → `validation_failed`。ContentType が allowlist 外 or ContentLength > MAX → `validation_failed` (オブジェクトは残置)
4. **共有 deadline を確定 + パーツ逐次送信**: `deadlineMs = Date.now() + SEND_TOTAL_BUDGET_MS` を 1 回計算 (research D4)。parts = [text (body 非空時), image] を順に処理。各パーツで:
   a. pending 行 INSERT (image パーツは `messageType:'image'`, `body:''`, `attachments:[{index:0, type:'image', s3Key, contentType, sizeBytes}]` — Head の値を記録)
   b. Meta 送信 (image は §5 のペイロード) に **同じ `deadlineMs` を渡す**。`sendMessengerReply` が残余時間で試行を切り詰める (§5)。presigned GET は既存 `getAttachmentUrl(s3Key)` で取得
   c. TX2 (既存): sent + metaMessageId / failed + sendError。`sendMessengerReply` の `timeout` (予算切れ含む) は既存マッピングで **`meta_error` に写像**する (新 `sendError` 値を作らない — research D4 / レビュー中-3)。予算切れは診断のため `reason:'budget_exceeded'` を `outbound_attachment_send_failed` にログ
   d. mid unique 衝突時の echo claim 回復も既存どおりパーツ単位で適用
5. 下書き dismiss / `lastMessageAt` 更新 / `maybeEnqueueSummaryJob` は**いずれかのパーツが成功したら最後に 1 回**実行する (全パーツ失敗なら実行しない — 既存の成功時挙動を踏襲。summary trigger の呼び出し漏れ防止 — レビュー N-2)

**Output** — 後方互換の拡張 (レビュー M-2):
```ts
// 成功時 (既存互換の message を維持)
{ ok: true, message: { id: string; body: string; timestamp: string; send_status: 'sent' }, parts?: PartResult[] }
// 失敗時
{ ok: false, error: SendError, details?: string, parts?: PartResult[] }

type PartResult = { kind: 'text' | 'image', ok: boolean, error?: SendError }
type SendError = 'outside_window' | 'token_expired' | 'meta_error' | 'validation_failed'  // 既存 union 不変
```
- `ok` は**全パーツ成功時のみ** true (既存クライアントの分岐互換)。`message` は最後に成功したパーツの行 (テキストのみ送信では従来と完全一致 — §10)
- `error` は ok=false 時、最初に失敗したパーツのエラー (既存互換)
- `parts` は attachment ありのときのみ付与する additive フィールド。テキストのみ送信では従来どおり `parts` なし → 既存テストが `result.message.*` をそのまま検証できる (M-2 の自己矛盾を解消)

**順序保証**: text パーツの sent/failed 確定前に image パーツの送信を開始しない。1 通目の失敗で 2 通目をスキップしない (independent — research D4。ただし予算共有のため 1 通目が予算を使い切ると 2 通目は試行なしで `meta_error` になり得る、D4 のトレードオフ参照)。

## 5. Meta Send API ペイロード契約 (`messenger.ts` 拡張)

`sendMessengerReply` を拡張する。(a) `message` 部を判別 union 入力にして (または `sendMessengerImage` を追加して) 画像ペイロードを送れるようにし、(b) optional `deadlineMs?: number` を追加する。

画像ペイロード:
```json
{
  "recipient": { "id": "<PSID>" },
  "messaging_type": "RESPONSE",
  "message": { "attachment": { "type": "image", "payload": { "url": "<presigned GET URL>", "is_reusable": false } } }
}
```

**deadline によるリトライ切り詰め** (research D4):
- 各試行の前に `remaining = deadlineMs - Date.now()` を計算する
- `remaining < SEND_MIN_ATTEMPT_MS` → 以降の試行を打ち切り `{ ok:false, error:'timeout' }` を返す (それ以上 Meta を呼ばない)
- そうでなければ当該試行の fetch timeout を `AbortSignal.timeout(min(TIMEOUT_MS, remaining))` にクランプする
- `deadlineMs` 省略時は現行と完全に同一挙動 (テキストのみ送信の後方互換)

**実挙動の明記** (research D3 — 旧記述「3 試行 500/1500/4500ms」は誤り):
- `TIMEOUT_MS = 5s`、`MAX_RETRIES = 3` (= 3 試行)。backoff は attempt>0 のみで実際は **500ms + 1500ms の 2 回**のみ発生 (4500ms は到達しない)
- timeout 経路は 1 回だけ再試行 (`if (attempt < 1) continue`)、2 回目 timeout は即 `meta_server_error`
- 1 通の最悪所要: 5xx 連続で ~17s、timeout 経路で ~10.5s。deadline があればこれが残余で切り詰められる
- エラーマッピング (`token_expired`/`outside_window`/`permission_denied`/`invalid_request`/`meta_server_error`/`timeout`)・`message_id` 取得はテキスト送信と共通

## 6. 表示契約 (変更なし — 回帰テストで固定)

- `get-conversation.fn.ts`: outbound 行の attachments も受信側と同じ `toUrl` (プレフィックス検証 + presign) を通る。**コード変更は `mediaUploadEnabled` フラグ追加のみ**
- `ThreadMessages.tsx`: outbound バブルは既に `AttachmentList` を描画するため変更なし
- echo upsert (webhook): `set: { sendStatus }` のみ — 送信時に書いた attachments を上書きしない。**webhook のコード変更なし**

## 7. UI 契約 (ReplyForm)

- 添付ボタンは `mediaUploadEnabled && !isWindowClosed` のときのみ活性
- **送信ガードの緩和 (レビュー M-3 — MVP の必須変更)**: 現行の `!body.trim()` ガードは画像のみ送信 (body='') を塞ぐ。以下 3 箇所を `!body.trim() && !attachment` (= テキストも添付も無いときだけ不可) に緩める:
  - `handleSubmit` の early-return ガード (`ReplyForm.tsx:162`)
  - 送信ボタンの `disabled` / `aria-disabled` (`:477-478`)
  - 送信ボタンの `background` / `cursor` スタイル (`:488-489`)
- 状態機械: `idle → picked(client検証済み) → uploading → ready → sending → done/failed`。`uploading`/`failed` からの再試行は**新しいアップロード URL を採番し直す** (§3。古いキーは失効・使い回さない)
- client 検証: ALLOWED_IMAGE_TYPES / MAX_ATTACHMENT_BYTES 外は選択時に即エラー表示 (i18n)、アップロードに進まない
- プレビュー: `URL.createObjectURL(file)` によるローカルサムネイル + 取り消しボタン (revoke を忘れない)
- 送信成功後: body / 添付状態をクリアし `router.invalidate()` (既存挙動)
- **部分失敗と再送 (レビュー低-5)**: `parts` を見て「テキストは送信済み、画像は失敗」を i18n 表示。再送は失敗パーツのみ — text 成功 + image 失敗なら **body を空にして attachment のみで再送**する (テキストの二重送信防止)。この時点で成功済みテキストは入力欄からクリアしておく
- **エラーコード → i18n 対応 (レビュー中-4)**: 既存キーを最大限流用する。
  | エラー源 | コード | 表示キー |
  |---|---|---|
  | createUploadUrlFn | `outside_window` | `reply_error_outside_window` (既存流用) |
  | createUploadUrlFn | `not_found` / `not_configured` / `validation_failed` | `thread_attach_upload_failed` |
  | S3 PUT (403/network) | — | `thread_attach_upload_failed` |
  | sendReplyFn | `outside_window`/`token_expired`/`meta_error`/`validation_failed` | 既存 `reply_error_*` マッピングを流用 (`ReplyForm.tsx:176-181`) |
  | client 検証 | 型不一致 / サイズ超過 | `thread_attach_invalid_type` / `thread_attach_too_large` |
- 新規 i18n キー (ja/en): `thread_attach_image`, `thread_attach_remove`, `thread_attach_invalid_type`, `thread_attach_too_large`, `thread_attach_upload_failed`, `thread_attach_partial_failure` (計 6 キー。最終キー名は実装時に既存規約へ揃える)

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

- `sendReplyFn` の `attachment` 省略時は入出力とも従来と完全一致 — 成功時 `{ ok:true, message:{...} }` (parts なし)、失敗時 `{ ok:false, error }`。§4 の Output はこの後方互換を保つ形で `parts` を additive に足すだけなので、`result.message.*` を検証する既存テスト (`send-reply.fn.test.ts`) は**無変更で通る** (M-2 解消)
- `getConversationFn` レスポンスへの `mediaUploadEnabled` 追加は additive (既存フィールド不変)
- DB 値パターンの追加 (outbound + attachments) は 009 の表示コード・AI worker (テキストのみ参照)・未返信バッチ (direction/timestamp のみ参照) に非干渉 (FR-015)
