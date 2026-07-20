# Implementation Plan: 受信画像・添付メディアの永続保存とスレッド表示

**Branch**: `009-media-attachments` | **Date**: 2026-07-18 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/009-media-attachments/spec.md`

## Summary

顧客が Messenger で送る添付メディア (画像・動画・音声・ファイル) を、Webhook 受信時に Meta の短命 CDN URL から**即ダウンロードして専用 S3 バケットに永続保存**し、`messages.attachments` (JSONB, 新規列) に種別・S3 キー・順序を記録する。スレッド UI は保存済み画像を**署名付き URL 経由の `<img>`** で表示し (クリックで原寸)、動画・音声・ファイル・スタンプ・不明は種別ラベル、取得不可はプレースホルダで表示して空バブル・生 URL 表示を根絶する。

1. 受信画像が永続表示される — URL 失効後も fumireply 保存コピーから表示 (User Story 1)
2. video / audio / file の種別判定を新設し、全非テキストを種別の分かる表示にする (User Story 2)
3. 保存失敗・過去データはプレースホルダに統一。過去の body 内 CDN URL は一度のデータ移行で除去 (User Story 3)

**アーキテクチャ要点** (詳細は `research.md` / `contracts/media-pipeline.md`):

- **新規 S3 バケット `fumireply-review-media`** (Terraform)。キーは `{tenantId}/{conversationId}/{sanitized_mid}/{index}` でテナント分離。Public Access Block 全有効 + SSE-S3。ライフサイクル・削除なし (保持期間は無期限 — 見直しは #78)。
- **ダウンロードは webhook handler 内で同期実行** (spec Q2: 即時リトライ 2 回まで、非同期キューなし)。失敗・25MB 超過は `s3Key: null` で「取得不可」確定し、メッセージ INSERT は必ず成功させる。webhook Lambda を **memory 512→1024MB / timeout 10→20 秒**に引き上げ (25MB バッファ + ダウンロード時間の余裕)。
- **DB は `messages.attachments jsonb` 1 列追加** (nullable, NULL = 添付なし/レガシー)。同一マイグレーションで過去 inbound 画像の `body` から失効 CDN URL を除去 (`UPDATE ... SET body='' WHERE message_type='image' AND body LIKE 'http%'`) — FR-004a。webhook 側スキーマ複製 (`webhook/src/db/schema.ts`) も同期。
- **配信は S3 presigned GET URL** (有効期限 1 時間) を `get-conversation.fn.ts` が `withTenant` (RLS) で選択した行に対してのみ発行。認可なし恒久 URL は存在しない (FR-011)。CloudFront 署名 URL は鍵ペア管理が増えるため不採用。
- **種別判定を `classifyAttachments()` に一本化**: text / image / sticker に video / audio / file を追加、複数添付を全件処理 (現行は先頭 1 件のみ)。inbound / echo 共通で使い、echo も添付保存を試みる (FR-009)。`determineEchoMessageType` の「image は body=''」ハックは本関数に吸収され廃止。
- **UI は `MessageBubble` に添付描画を追加**: image → `<img>` + クリックで原寸モーダル、その他 → Paraglide の種別ラベル、`s3Key: null` → 「(取得不可)」プレースホルダ。既存のインライン style + CSS 変数の流儀に従い Tailwind クラスは使わない。
- **観測性**: `attachment_stored` / `attachment_download_failed` / `attachment_skipped_oversize` を構造化ログで出力 (既存の `event=` オブジェクト形式)。カスタムメトリクス・アラームなし (FR-013)。
- **AI 下書き・未返信バッチ非干渉**: 非テキストは従来どおり下書きを発火しない。echo 副作用なしも維持 (FR-014)。

## Technical Context

**Language/Version**: TypeScript 5.x / Node.js (`nodejs22.x` Lambda)。001〜006 と同一。
**Package Manager**: npm (`webhook/package-lock.json`, `app/package-lock.json`)。
**HTTP クライアント方針**: グローバル `fetch` のみ (メディアダウンロードも `fetch` + `AbortSignal.timeout`)。axios 系の新規導入禁止。

**Primary Dependencies**:
- webhook: `@aws-sdk/client-s3` を dependencies に追加 (既存方針どおり esbuild で external 化、Lambda 同梱 SDK を利用)。
- app: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` を dependencies に追加 (presigned URL 発行はローカル署名のみでネットワーク I/O なし)。
- 既存 `drizzle-orm` / `zod` / Paraglide はそのまま。他の新規 npm なし。

**Infrastructure** (Terraform 変更あり):
- 新規: `aws_s3_bucket` `fumireply-review-media` + versioning 無効 + Public Access Block + SSE-S3 (AES256)。`envs/review/main.tf` に artifacts バケットと同じインライン方式で追加。
- `modules/webhook-lambda`: 変数 `media_bucket_arn` / `media_bucket_name` 追加 → IAM inline policy に `s3:PutObject` (`${arn}/*`)、env に `MEDIA_BUCKET_NAME`、`memory_size 512→1024`、`timeout 10→20`。
- `modules/app-lambda`: 変数追加 → IAM に `s3:GetObject` (`${arn}/*`)、env に `MEDIA_BUCKET_NAME`。
- SSM パラメタ追加なし。Meta App 管理画面の作業なし (添付は既存 `messages` 購読フィールドに含まれる)。

**Storage**: 既存 Supabase Postgres + 新規マイグレーション 1 本 (`0004_*`): `messages.attachments jsonb` 追加 + レガシー body クリーンアップ UPDATE。RLS は既存の行ポリシーがそのまま `attachments` 列を保護。S3 は上記新バケット。

**Testing & CI**:
- vitest (webhook): `aws-sdk-client-mock` で S3 をモック、`fetch` は `vi.stubGlobal`。ケース: image 1 枚保存成功 / 複数添付全件 / ダウンロード失敗→リトライ→取得不可 (INSERT は成功) / Content-Length 超過スキップ / video・audio・file 種別判定 / echo 添付保存 / sticker は保存しない / 構造化ログ 3 イベント / body に URL を入れない
- vitest (app): `get-conversation.fn` が attachments に presigned URL を付与して返す / `s3Key: null` は `url: null` / 旧データ (attachments NULL) は空配列
- Playwright E2E スモーク: 画像メッセージが `<img>` で表示・プレースホルダ表示 (seed データ)
- 既存 Stop フック (typecheck + lint) は変更なしで通ること

**Target Platform**: AWS Lambda + API Gateway / CloudFront / Supabase (001〜006 と同一)。

**Project Type**: 既存 webhook Lambda + app (TanStack Start) + Terraform の 3 面拡張。

**Performance Goals**:
- 画像 (典型 <1MB) のダウンロード + PutObject で webhook 応答は p95 +2 秒以内。Meta の webhook 配信 SLA (~20 秒) 内に収まる (timeout 20 秒)。
- presigned URL 発行はローカル署名のみで `get-conversation` のレイテンシ影響は無視できる (<1ms/件)。

**Constraints**:
- **同期ダウンロードの時間予算**: 添付は逐次処理、1 添付あたり fetch timeout 8 秒 × 最大 3 試行 (初回 + リトライ 2、backoff 200ms/500ms)。Lambda timeout 20 秒を超えそうな複数大型添付は後続添付が「取得不可」に落ちるが、メッセージ INSERT は完遂する (research.md 参照)。
- **サイズ上限 25MB** (spec Q4): `Content-Length` があれば事前判定、なければストリーミング読みで累積 25MB 超過時に中断。
- **テナント分離**: S3 キー先頭が `tenantId`、発行済み presigned URL は `withTenant` (RLS) を通過した行の `s3Key` からのみ生成。バケットは Public Access Block で直接アクセス不可。
- **冪等性**: 同一 mid の再配信は既存の `onConflictDoNothing` / UPSERT で行が増えない。S3 は同一キーへの再 PUT で上書き (内容同一) となり無害。
- **後方互換**: `attachments` NULL の既存行は「添付情報なし」として扱い、UI は message_type からプレースホルダ/ラベルを導出。旧形式 (body=URL) の判定ロジックは持たない (FR-004a のデータ移行で消滅)。
- **デプロイ順序**: (1) terraform apply (バケット + IAM + env) → (2) DB マイグレーション → (3) webhook / app コードデプロイ。逆順でも env 未設定時は添付保存をスキップしてログを残すだけでメッセージ取り込みは壊れない。

**Scale/Scope**:
- 追加・変更コード LOC 目安: ~700 行
  - `webhook/src/services/media.ts` (NEW: ダウンロード + サイズガード + リトライ + PutObject) ~120 行
  - `webhook/src/handler.ts` (MODIFY: classifyAttachments 化、inbound/echo 両経路の添付処理、attachments INSERT、ログ) ~90 行
  - `webhook/src/db/schema.ts` (MODIFY: attachments 列同期) ~3 行
  - webhook tests (NEW/MODIFY) ~180 行
  - `app/src/server/db/schema.ts` + migration 0004 ~20 行
  - `app/src/server/services/media-url.ts` (NEW: presigner ラッパ) ~40 行
  - `app/src/routes/(app)/threads/$id/-lib/get-conversation.fn.ts` (MODIFY: attachments select + URL 付与) ~40 行
  - `app/src/routes/(app)/threads/$id/-components/ThreadMessages.tsx` (MODIFY: 添付描画 + 原寸モーダル) ~130 行
  - `app/messages/{ja,en}.json` (種別ラベル・プレースホルダ・モーダル閉じる) ~16 キー
  - app tests ~60 行
  - terraform (バケット + 2 モジュールの var/IAM/env) ~120 行

## Constitution Check

*GATE: Phase 0 前にパス、Phase 1 設計後に再チェック。*

**プロジェクト憲法の状態**: `.specify/memory/constitution.md` 未ラティファイ (テンプレ状態)。001〜006 同様、業界標準ゲートを暫定適用する。

| ゲート | 判定 | 根拠 |
|---|---|---|
| **YAGNI** | ✅ PASS | 送信側メディア、インライン動画再生、非同期再取得キュー、CloudFront 配信、サムネイル生成は明示除外。列 1 本 + バケット 1 個 + 同期ダウンロードの最小構成。 |
| **単一責任** | ✅ PASS | ダウンロード/保存は `media.ts`、種別判定は `classifyAttachments`、URL 発行は `media-url.ts` に分離。handler は編成のみ。 |
| **テスト可能性** | ✅ PASS | `fetch` と S3 をモックすれば `メッセージイベント → attachments JSONB` の純関数的検証が可能。既存 handler.test.ts のパターンを踏襲。 |
| **シンプル優先** | ✅ PASS | 新規 Lambda・SQS・SSM なし。presigned URL は鍵管理不要。マイグレーション 1 本。 |
| **観測性** | ✅ PASS | `attachment_stored` / `attachment_download_failed` / `attachment_skipped_oversize` を既存規約 (`event=` JSON) で出力、Logs Insights で集計可 (SC-005)。 |
| **可逆性** | ✅ PASS | コードロールバックで旧挙動 (添付無視) に戻る。`attachments` 列は nullable で旧コードに無害。バケットは残るが参照されないだけ。レガシー body クリーンアップのみ不可逆だが、対象は失効済み URL 文字列で情報価値ゼロ (spec Q3 で承認済み)。 |

**複雑性の正当化**: 不要。

**Phase 1 設計後の再チェック (2026-07-18)**: 全 6 ゲート PASS 維持。data-model で列追加は `attachments` 1 本のみ、状態は JSONB 内で完結し新テーブルなし。contracts で S3 キー構造・JSONB スキーマ・ログイベント・IAM 差分を固定。

## Project Structure

### Documentation (this feature)

```text
specs/009-media-attachments/
├── spec.md                       # 仕様書 (clarify 4 問反映済み)
├── plan.md                       # 本ファイル
├── research.md                   # Phase 0 (同期ダウンロード判断 / presigned URL vs CloudFront / サイズガード / Lambda リソース)
├── data-model.md                 # Phase 1 (attachments JSONB スキーマ / レガシー移行 / 状態パターン)
├── quickstart.md                 # Phase 1 (terraform apply → migration → デプロイ手順 + Logs Insights クエリ + 手動検証)
├── contracts/
│   └── media-pipeline.md         # 種別判定表 / S3 キー契約 / JSONB 契約 / presigned URL 契約 / IAM 差分 / ログイベント
└── checklists/
    └── requirements.md           # 品質チェックリスト (specify で作成済み)
```

### Source Code (変更/追加ファイル中心)

```text
webhook/
├── src/
│   ├── handler.ts                             # MODIFY: classifyAttachments / inbound・echo 添付処理 / attachments INSERT / ログ
│   ├── services/
│   │   └── media.ts                           # NEW: downloadAttachment (fetch + 25MB ガード + リトライ) / storeAttachment (PutObject)
│   ├── db/schema.ts                           # MODIFY: messages.attachments jsonb 同期
│   ├── handler.test.ts                        # MODIFY: 添付保存/失敗/超過/echo/複数/種別 テスト追加
│   └── services/media.test.ts                 # NEW
├── package.json                               # MODIFY: @aws-sdk/client-s3 追加

app/
├── src/
│   ├── server/
│   │   ├── db/schema.ts                       # MODIFY: messages.attachments jsonb
│   │   ├── db/migrations/0004_*.sql           # NEW: 列追加 + レガシー body クリーンアップ
│   │   ├── services/media-url.ts              # NEW: getAttachmentUrl (presigned GET, 1h)
│   │   └── env.ts                             # MODIFY: MEDIA_BUCKET_NAME
│   └── routes/(app)/threads/$id/
│       ├── -lib/get-conversation.fn.ts        # MODIFY: attachments select + presigned URL 付与
│       └── -components/ThreadMessages.tsx     # MODIFY: 画像 <img> + 原寸モーダル + 種別ラベル + プレースホルダ
├── messages/{ja,en}.json                      # MODIFY: thread_attachment_* キー追加
├── package.json                               # MODIFY: @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

terraform/
├── envs/review/main.tf                        # MODIFY: media バケット追加、モジュールへ bucket 変数受け渡し
├── modules/webhook-lambda/{main,variables}.tf # MODIFY: IAM PutObject / env / memory 1024 / timeout 20
└── modules/app-lambda/{main,variables}.tf     # MODIFY: IAM GetObject / env
```

**Structure Decision**: メディア入出力を webhook 側 `services/media.ts` (書き込み) と app 側 `services/media-url.ts` (読み取り URL 発行) に対称に切り出し、handler / server fn は編成に徹する。DB は列 1 本の追加で新テーブル・新インデックスを作らない (添付はメッセージのライフサイクルに完全従属するため JSONB が最小)。配信は CloudFront を経由させず presigned S3 URL 直返しとし、インフラ面の新規要素をバケット 1 個に抑える。

## Complexity Tracking

> 不要 (Constitution Check で違反なし)。
