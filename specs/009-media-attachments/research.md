# Research: 受信画像・添付メディアの永続保存とスレッド表示 (009)

Phase 0 成果物。spec.md の要求 (FR-001〜FR-014, Clarifications Q1〜Q4) を実装可能な設計判断に落とす。すべての NEEDS CLARIFICATION は解消済み (clarify セッション 2026-07-18)。

## R1. メディアダウンロードの実行位置 — webhook handler 内で同期実行

**Decision**: 添付ダウンロード + S3 保存は `webhook/src/handler.ts` の受信処理内で同期的に行う。新規 SQS キュー・非同期ワーカーは作らない。

**Rationale**:
- Meta の attachment URL は署名付き CDN URL で短命。確実に生きているのは受信直後だけ (issue #73 / Meta 公式コミュニティの回答)。spec Q2 で「受信処理内の即時リトライのみ、非同期再試行なし」と確定済み。
- webhook Lambda は API Gateway 直結の同期実行 (SQS 非経由, handler.ts:452-464)。ダウンロードをここで行えば追加のインフラ (キュー・ワーカー・可視性管理) がゼロで済む。
- 失敗時の挙動が単純: その場で「取得不可」確定 → attachments に `s3Key: null` を記録して INSERT 続行。リカバリ状態機械が不要。

**Alternatives considered**:
- **既存 ai-draft キューに media ジョブを混ぜる / 新規キュー**: URL 失効リスクは数秒〜数分では低いが、「非同期再試行キューは設けない」(spec Q2) に反する。ワーカー側にも DB 書き戻し・部分失敗処理が増え、webhook 応答速度の改善幅 (典型 <1 秒) に見合わない。却下。
- **Lambda response streaming / 応答後バックグラウンド処理**: Lambda は応答返却後の処理継続を保証しない。却下。

## R2. 配信方式 — S3 presigned GET URL (有効期限 1 時間)

**Decision**: app の `get-conversation.fn.ts` が、`withTenant` (RLS) で取得した行の `s3Key` に対して S3 presigned GET URL (expiry 3600 秒) を発行し、UI はそれを `<img src>` に使う。

**Rationale**:
- presign はローカル署名のみ (ネットワーク I/O なし、<1ms/件)。`@aws-sdk/s3-request-presigner` の追加だけで実現できる。
- 認可は「server fn の authMiddleware + RLS を通過した行だけが URL 化される」ことで担保 (FR-011)。URL 自体も 1 時間で失効するため、恒久公開 URL は存在しない。
- app には CSP が未設定 (`__root.tsx` は charset/viewport/title のみ) のため、S3 ドメインの `<img>` 読み込みに障害はない。
- スレッド画面は既存のポーリング再取得があるため、長時間開きっぱなしでも URL は自然に更新される。

**Alternatives considered**:
- **CloudFront signed URL / signed cookie**: 鍵ペアの生成・SSM 保管・ローテーションと distribution 変更が増える。キャッシュ効率の利点は現スケールで不要。却下。
- **app Lambda でバイナリをプロキシ配信** (`/api/media/...`): Lambda Web Adapter 経由のバイナリ応答 + 毎回 S3 GetObject でレイテンシ・コスト増。API Gateway 10MB 応答制限にも抵触 (25MB 動画を将来配信する場合)。却下。
- **バケット公開 + 推測困難キー**: 認可なし恒久 URL であり FR-011 に真っ向から反する。却下。

## R3. S3 バケットとキー設計

**Decision**: 新規バケット `fumireply-review-media` (名前は `${name_prefix}-media`)。キーは:

```
{tenantId}/{conversationId}/{sanitized_mid}/{index}
```

- `sanitized_mid`: Meta の `mid` を `[^A-Za-z0-9._-]` → `_` に置換したもの (mid は `m_` 始まりの base64 系文字列で `=` 等を含みうる)
- `index`: メッセージ内の添付順序 (0 始まり)
- オブジェクトメタデータに `Content-Type` (ダウンロード時のレスポンスヘッダ由来、欠落時 `application/octet-stream`) を設定 — presigned GET で正しい MIME で配信するため

バケット設定: Public Access Block 全有効 / SSE-S3 (AES256) / versioning 無効 / ライフサイクルなし (保持は無期限, spec Q1。見直しは #78)。

**Rationale**:
- 先頭 `tenantId` プレフィックスでテナント分離が自明になり (FR-010)、将来テナント単位の一括削除 (#78 の検討事項) もプレフィックス指定で可能。
- `mid` ベースなら Meta の再配信 (同一 mid) で同一キーに再 PUT され、内容同一の上書きで冪等。
- versioning はメディアが不変 (immutable) なので不要。SSE-KMS でなく SSE-S3 なのは、鍵管理の追加なしで暗号化要件を満たすため (state バケットの KMS は Terraform 状態という高機密用途で、顧客メディアは AES256 で十分と判断)。

**Alternatives considered**:
- **メッセージ UUID ベースのキー**: INSERT 前にダウンロードするフローでは行 ID が未確定 (`defaultRandom`)。mid は受信時点で確定しており自然。却下。
- **既存 artifacts / static バケットへの同居**: 用途・IAM 境界・ライフサイクルが混ざる。却下。

## R4. 添付情報の持ち方 — `messages.attachments` JSONB 1 列

**Decision**: `messages` に nullable の `attachments jsonb` を追加。値は配列:

```json
[
  { "index": 0, "type": "image", "s3Key": "ten…/conv…/m_abc/0", "contentType": "image/jpeg", "sizeBytes": 123456 },
  { "index": 1, "type": "video", "s3Key": null }
]
```

- `s3Key: null` = 取得不可 (ダウンロード失敗 / サイズ超過) または保存対象外 (sticker / unknown)
- `NULL` (列ごと) = 添付なし、または本機能以前のレガシー行
- 別テーブルは作らない

**Rationale**:
- 添付はメッセージに完全従属 (単独で照会・更新されない)。表示時は常にメッセージと同時に読むため、JOIN 不要の JSONB が最小コスト。issue #73 も「単一 `media_url` 列より複数添付に対応しやすい JSONB」を提案。
- RLS: `messages` の既存行ポリシーが列ごと保護するため、追加のポリシー変更なし。
- 検索・集計要件 (「画像を含む会話を探す」等) は現時点で存在しない。必要になれば GIN index を後付けできる。

**Alternatives considered**:
- **`message_attachments` 別テーブル**: 正規化は綺麗だが、マイグレーション・RLS ポリシー・スキーマ複製 (webhook 側) の同期対象が増える。参照パターンが「常に親と一緒」の現状では過剰。却下。
- **単一 `media_url` / `media_key` 列**: 複数添付 (spec Edge Case) に対応できない。却下。

## R5. サイズガードとダウンロード実装

**Decision**: `webhook/src/services/media.ts` に `downloadAttachment(url, { maxBytes: 25MB, timeoutMs: 8000 })` を実装:

1. `fetch(url, { signal: AbortSignal.timeout(8000) })`
2. `Content-Length` ヘッダがあり 25MB 超 → 即 `{ ok: false, reason: 'oversize' }` (本文を読まない)
3. ヘッダなし/25MB 以下 → `response.body` のリーダーで chunk 累積、累積が 25MB を超えた時点で reader.cancel → `oversize`
4. 成功時 `{ ok: true, buffer, contentType, sizeBytes }`

リトライ: 呼び出し側で最大 3 試行 (初回 + 2 リトライ、間隔 200ms / 500ms)。`oversize` はリトライしない (決定的失敗)。ネットワークエラー・非 2xx・タイムアウトのみリトライ対象。

**Rationale**:
- 25MB は spec Q4 で確定。Messenger 送信上限相当のため、実運用で `oversize` はほぼ発生しない防御線。
- ストリーミング累積により `Content-Length` を偽る/欠くレスポンスでもメモリを 25MB + α に抑制。1024MB Lambda で複数添付を逐次処理しても安全。
- リトライ間隔が短いのは「URL が生きているのは今だけ」という前提のため。長い backoff に意味がない (spec Q2)。

## R6. webhook Lambda リソース — memory 1024MB / timeout 20 秒

**Decision**: `modules/webhook-lambda` の `memory_size` を 512→1024、`timeout` を 10→20 に変更。

**Rationale**:
- 25MB バッファ + Node ヒープ余裕。メモリ倍増は vCPU 配分も増え、TLS/ダウンロードスループットが上がる。
- timeout 20 秒: 典型画像 (<1MB) は 1 秒未満で完了するが、25MB 動画 ×1 のワーストで 8 秒 fetch + PutObject を吸収する余裕。API Gateway HTTP API の統合上限 30 秒、Meta の webhook 応答期待 (~20 秒) の内側に収める。
- ダウンロードは逐次処理のため、多数添付 + 大型で 20 秒を使い切る場合は後続添付が「取得不可」になるが、メッセージ INSERT は完遂する設計 (FR-003)。Lambda timeout 自体に達するとメッセージごと失敗し Meta が再配信する — 再配信は `onConflictDoNothing` で冪等、かつ 2 回目は同じ URL でダウンロード再挑戦できるため、実質的な追加リトライとして機能する。

## R7. 種別判定 — `classifyAttachments()` へ一本化

**Decision**: 現行の `determineMessageType` / `determineEchoMessageType` を置き換える単一関数:

```
classifyAttachments(msg) → { messageType, body, attachments: AttachmentDescriptor[] }
```

- `msg.text` あり → `messageType='text'`, `body=text`。テキストと添付が共存すれば attachments も併せて返す (spec Edge Case)
- 添付ごとの type 判定: `payload.sticker_id` → `sticker` / `att.type` が `image|video|audio|file` → そのまま / それ以外 → `unknown`
- `messageType` (列) はテキストなしの場合、先頭添付の type。全添付は attachments 配列に記録 (現行の「先頭 1 件のみ」を廃止)
- **body には URL を入れない** (FR-004: 現行 inbound image の `body=att.payload.url` ハック廃止)
- ダウンロード対象: `image|video|audio|file` かつ `payload.url` あり。`sticker`/`unknown` は記録のみ (`s3Key: null`)
- inbound / echo 共通で使用 (FR-009)。`determineEchoMessageType` は削除

**Rationale**: 判定ロジックの二重管理 (006 で意図的に分けた) は「echo は URL を保存しない」という差分のためだったが、本機能で inbound も URL を body に入れなくなるため差分自体が消滅する。

## R8. レガシーデータ移行 (FR-004a)

**Decision**: マイグレーション `0004_*` に以下を含める:

```sql
ALTER TABLE "messages" ADD COLUMN "attachments" jsonb;
UPDATE "messages" SET "body" = '' WHERE "message_type" = 'image' AND "body" LIKE 'http%';
```

**Rationale**:
- 対象は「inbound 画像で body に CDN URL を保存していた」行のみ。`message_type='image' AND body LIKE 'http%'` で正確に絞れる (テキストは `message_type='text'`、echo 画像は既に `body=''`)。
- URL は失効済みで情報価値ゼロ (spec Q3 で確定)。`attachments` は NULL のままにし、UI は「画像 (取得不可)」プレースホルダを表示する。
- drizzle-kit generate で列追加 SQL を生成後、同ファイルに UPDATE を手で追記する (0001_rls.sql と同様に手書き SQL の前例あり)。

## R9. 構造化ログイベント

**Decision**: 既存規約 (`console.info/warn/error` + `{ event: '...', ...fields }` JSON) で以下を追加:

| event | level | fields | 意味 |
|---|---|---|---|
| `attachment_stored` | info | tenantId, conversationId, mid, index, type, sizeBytes | S3 保存成功 |
| `attachment_download_failed` | warn | tenantId, mid, index, type, attempts, reason | 3 試行後の失敗 (取得不可確定) |
| `attachment_skipped_oversize` | warn | tenantId, mid, index, type, sizeBytes? | 25MB 超過スキップ |

CloudWatch Logs Insights で `event` によるフィルタ集計が可能 (SC-005)。カスタムメトリクス・アラームは追加しない (FR-013)。

## R10. UI 描画

**Decision**: `MessageBubble` に添付描画を追加。既存の流儀 (インライン style + CSS 変数、Tailwind 不使用、Paraglide `m.*()`) に従う。

- `attachments` の各要素:
  - `type='image'` かつ `url` あり → `<img>` (max-width 240px / border-radius / `loading="lazy"`)。クリックで原寸モーダル (`position:fixed` オーバーレイ + `<img>` 原寸、Esc/背景クリックで閉じる)。新規ライブラリ不使用
  - `type='image'` かつ `url` なし → `m.thread_attachment_image_unavailable()` プレースホルダ
  - `video`/`audio`/`file`/`sticker`/`unknown` → 種別ラベル (`m.thread_attachment_video()` 等)。`url` があっても本リリースではインライン再生しない (spec Assumptions)
- `attachments` が NULL/空で `message_type` が非 text → message_type から同じラベル/プレースホルダを導出 (レガシー行対応)
- server fn 返却型: `MessageWithDraft` に `attachments: { index, type, url: string | null }[]` を追加。`s3Key` はクライアントに渡さない (内部キーの露出防止)

**i18n キー** (ja/en): `thread_attachment_image_unavailable`, `thread_attachment_video`, `thread_attachment_audio`, `thread_attachment_file`, `thread_attachment_sticker`, `thread_attachment_unknown`, `thread_attachment_image_alt`, `thread_attachment_modal_close`

## R11. フェイルセーフとデプロイ順序

**Decision**:
- webhook: `MEDIA_BUCKET_NAME` が未設定なら添付ダウンロードをスキップし、種別記録のみ行い `attachment_download_failed (reason: bucket_not_configured)` を warn ログ。メッセージ取り込みは通常どおり成功
- app: `MEDIA_BUCKET_NAME` 未設定時は `url: null` を返しプレースホルダ表示
- デプロイ順序: terraform apply (バケット/IAM/env) → `npm run db:migrate` (app) → コードデプロイ。どの順序でも受信メッセージが失われないことを上記フェイルセーフで担保

**Rationale**: 部分デプロイ状態 (コード先行 / インフラ先行) が一時的に発生しても FR-003 (メッセージ INSERT は必ず成功) を破らない。
