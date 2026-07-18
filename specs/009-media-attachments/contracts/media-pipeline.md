# Contract: メディア添付パイプライン (009)

受信 (webhook) → 保存 (S3) → 記録 (messages.attachments) → 配信 (presigned URL) → 表示 (MessageBubble) の各境界の契約。

## 1. 種別判定契約 — `classifyAttachments(msg)`

`webhook/src/handler.ts`。現行 `determineMessageType` / `determineEchoMessageType` を置換し、inbound / echo 両経路で共用する。

```ts
classifyAttachments(msg: MetaMessage): {
  messageType: string                      // 'text' | 'image' | 'sticker' | 'video' | 'audio' | 'file' | 'unknown'
  body: string                             // msg.text ?? ''  (URL は決して入らない)
  attachments: AttachmentPlan[]            // 添付なしなら []
}

interface AttachmentPlan {
  index: number
  type: 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'unknown'
  url: string | null                       // ダウンロード候補 URL (payload.url)
  shouldStore: boolean                     // type ∈ {image,video,audio,file} かつ url あり
}
```

判定表 (添付 1 件あたり):

| 条件 | type | shouldStore |
|---|---|---|
| `payload.sticker_id` あり | `sticker` | false |
| `att.type === 'image'` | `image` | `payload.url` あり |
| `att.type === 'video'` | `video` | 同上 |
| `att.type === 'audio'` | `audio` | 同上 |
| `att.type === 'file'` | `file` | 同上 |
| その他 (`fallback`, `template`, 未知) | `unknown` | false |

- `messageType`: `msg.text !== undefined` なら `'text'`。それ以外は `attachments[0].type`、添付ゼロなら `'unknown'`
- 全添付を処理する (現行の「先頭 1 件のみ」廃止)

## 2. ダウンロード・保存契約 — `webhook/src/services/media.ts`

```ts
downloadAttachment(url: string, opts: { maxBytes: 26_214_400, timeoutMs: 8_000 }):
  Promise<
    | { ok: true; buffer: Buffer; contentType: string; sizeBytes: number }
    | { ok: false; reason: 'oversize' | 'http_error' | 'network_error' | 'timeout' }
  >

storeAttachment(params: {
  bucket: string; tenantId: string; conversationId: string;
  mid: string; index: number; buffer: Buffer; contentType: string;
}): Promise<string>   // 返り値 = S3 キー
```

- リトライは呼び出し側 (handler): `oversize` 以外の失敗を最大 2 回再試行 (計 3 試行、間隔 200ms → 500ms)
- `Content-Length > maxBytes` なら本文を読まず即 `oversize`。ヘッダなしはストリーミング累積で超過時に中断
- S3 キー: `{tenantId}/{conversationId}/{sanitizeMid(mid)}/{index}`。`sanitizeMid` = `/[^A-Za-z0-9._-]/g` → `'_'`
- `PutObject` に `ContentType` を設定 (欠落時 `application/octet-stream`)
- `MEDIA_BUCKET_NAME` 未設定時: handler はダウンロード自体をスキップし全対象を `s3Key: null` で記録 (`reason: 'bucket_not_configured'` を warn ログ)

## 3. DB 書き込み契約 (inbound / echo 共通)

- ダウンロード・保存は **トランザクション外で先行実行**し、確定した `MessageAttachment[]` を値として INSERT する (S3 I/O で DB tx を長時間保持しない)
- inbound INSERT: 既存列 + `attachments` (計画ゼロ件なら NULL)。`onConflictDoNothing` は現行維持 — 重複 mid 時は S3 に保存済みオブジェクトが残るが、同一キーなので孤児にならない
- echo UPSERT: INSERT 値に `attachments` を追加。**`onConflictDoUpdate` の SET は現行どおり `sendStatus` のみ** (既存自送信行の attachments を echo で上書きしない — fumireply 送信にはそもそも添付機能がないため常に無害)
- 非テキスト inbound は現行どおり AI 下書きを発火しない。echo の副作用なし (SQS/Summary/NameFetch) も現行維持

## 4. 配信契約 — `app/src/server/services/media-url.ts` + `get-conversation.fn.ts`

```ts
getAttachmentUrl(s3Key: string): Promise<string>
// GetObjectCommand + getSignedUrl, expiresIn: 3600
// MEDIA_BUCKET_NAME 未設定なら null を返す (呼び出し側で url: null)
```

- `get-conversation.fn.ts` は SELECT に `attachments` を追加し、各要素を `{ index, type, url }` へ変換して返す:
  - `s3Key` 非 null → presigned URL
  - `s3Key` null / バケット未設定 → `url: null`
  - DB 値 NULL → `attachments: []`
- **`s3Key` はレスポンスに含めない**
- 認可: authMiddleware (認証) + `withTenant` RLS (テナント分離) を通過した行のみが presign 対象。これが FR-011 の実装

## 5. UI 表示契約 — `ThreadMessages.tsx` `MessageBubble`

| 入力 | 表示 |
|---|---|
| `attachments[n].type='image'` + `url` | `<img src={url} loading="lazy">` (max-width 240px)。クリック → 原寸モーダル (fixed オーバーレイ、Esc/背景クリックで閉じる) |
| `attachments[n].type='image'` + `url: null` | `m.thread_attachment_image_unavailable()` |
| `attachments[n].type='video'/'audio'/'file'/'sticker'/'unknown'` | 対応する `m.thread_attachment_*()` ラベル |
| `attachments: []` かつ `message_type` 非 text (レガシー行) | `message_type` から同じラベル/プレースホルダを導出 (`image` → 取得不可プレースホルダ) |
| `body` 非空 | 従来どおりテキスト描画 (添付と共存時は両方) |

- 空バブル禁止: 非テキストで body 空でも必ず何らかの表示を出す (SC-003)
- インライン style + CSS 変数 (`var(--color-*)`) の既存流儀。新規ライブラリなし
- Paraglide キー (ja/en 両方): `thread_attachment_image_unavailable`, `thread_attachment_video`, `thread_attachment_audio`, `thread_attachment_file`, `thread_attachment_sticker`, `thread_attachment_unknown`, `thread_attachment_image_alt`, `thread_attachment_modal_close`

## 6. Terraform / IAM 差分契約

| リソース | 変更 |
|---|---|
| `envs/review/main.tf` | `aws_s3_bucket` `fumireply-review-media` + `aws_s3_bucket_public_access_block` (全 true) + `aws_s3_bucket_server_side_encryption_configuration` (AES256)。versioning・ライフサイクルなし。モジュールへ `media_bucket_name` / `media_bucket_arn` を受け渡し |
| `modules/webhook-lambda` | 変数 2 個追加 / inline policy に `s3:PutObject` on `${media_bucket_arn}/*` / env `MEDIA_BUCKET_NAME` / `memory_size = 1024` / `timeout = 20` |
| `modules/app-lambda` | 変数 2 個追加 / inline policy に `s3:GetObject` on `${media_bucket_arn}/*` / env `MEDIA_BUCKET_NAME` |
| SSM / Meta App 設定 | 変更なし |

webhook は Put のみ・app は Get のみ (最小権限)。`s3:ListBucket` はどちらにも付与しない。

## 7. 構造化ログ契約

既存規約: `console.info/warn` に `{ event: '...', ...fields }` の JSON オブジェクト。

| event | level | 必須 fields |
|---|---|---|
| `attachment_stored` | info | `tenantId`, `conversationId`, `mid`, `index`, `type`, `sizeBytes` |
| `attachment_download_failed` | warn | `tenantId`, `mid`, `index`, `type`, `attempts`, `reason` (`http_error`\|`network_error`\|`timeout`\|`put_failed`\|`bucket_not_configured`) |
| `attachment_skipped_oversize` | warn | `tenantId`, `mid`, `index`, `type` (+`sizeBytes` 判明時) |

保存成功率 (SC-005) = `attachment_stored` / (`attachment_stored` + `attachment_download_failed` + `attachment_skipped_oversize`) で Logs Insights 集計。
