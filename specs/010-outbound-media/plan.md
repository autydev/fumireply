# Implementation Plan: 送信側メディア添付 — オペレーターから顧客への画像送信

**Branch**: `010-outbound-media` | **Date**: 2026-07-20 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/010-outbound-media/spec.md` (親 Issue: autydev/fumireply#82)

## Summary

オペレーターがスレッドの返信フォームから画像 (jpeg/png/gif/webp、1 送信 1 枚、上限 25MB) を添付して顧客の Messenger に送信できるようにする。画像は**ブラウザから S3 に直接アップロード** (presigned PUT — Lambda payload 上限の回避) し、`sendReplyFn` が **presigned GET URL を Send API の `attachment.payload.url`** に載せて配信する。送信メッセージは 009 の `messages.attachments` JSONB に**送信時点で**添付を記録し (echo backfill には依存しない)、既存の outbound バブル描画で表示する。

1. 画像 1 枚を添付 → 送信 → 顧客に届き自社スレッドにも表示 (User Story 1 = MVP)
2. テキスト+画像はテキスト → 画像の順に 2 通逐次送信、成否は行単位で独立 (User Story 2)
3. 形式/サイズの二重検証・24h ウィンドウ・失敗表示と再送で無言の失敗を排除 (User Story 3)

**アーキテクチャ要点** (詳細は `research.md` / `contracts/outbound-media.md`):

- **アップロードはブラウザ → S3 直接** (research D1): 新 server fn `createUploadUrlFn` がサーバー採番キー + presigned PUT URL (300s, ContentType 固定) を発行。server fn 経由のバイナリは Lambda payload ~6MB + base64 膨張で不成立のため。サイズの最終強制は送信時の `HeadObject`
- **S3 キーは `{tenantId}/{conversationId}/outbound/{uuid}/0`** (research D2): mid 未確定のため UUID 採番。先頭 2 セグメントを受信側と揃え、表示側 `toUrl` のプレフィックス検証を無変更で通す
- **Meta へは presigned GET URL 方式** (research D3): 既存 `getAttachmentUrl` (1h) を `payload.url` に渡す。Attachment Upload API は MVP 不採用。タイムアウト・リトライ・エラーマッピングはテキスト送信と共用
- **2 通逐次送信 + 共有 deadline** (research D4): parts = [text?, image] を順に (pending INSERT → 送信 → 確定)。`sendMessengerReply` に `SEND_TOTAL_BUDGET_MS=25s` の共有 deadline を渡し試行を残余で切り詰めることで、2 通合計を予算内に収め pending 放置 (008 の教訓) を防ぐ。予算切れ/timeout は既存 `meta_error` に写像 (新 DB 値なし)
- **サイズは S3 が強制** (research D1): presigned PUT に `ContentLength` を署名し、過大アップロードを S3 が 403 で拒否 (悪用/コスト対策)。孤児・保持期間のライフサイクルは #78
- **DB 変更ゼロ** (data-model): `messages.attachments` を outbound でも書くだけ。echo upsert は sendStatus しか触らないため添付は消えない (FR-012、webhook 変更なし)
- **UI は ReplyForm に添付ボタン + プレビュー + 状態機械** (contracts §7)。表示側 (`ThreadMessages.tsx`) は変更なし — outbound バブルは既に `AttachmentList` を描画する
- **フェイルセーフ** (research D6): `MEDIA_BUCKET_NAME` 未設定環境は `mediaUploadEnabled: false` で添付 UI 非表示 + サーバー側でも拒否
- **観測性** (research D8): `outbound_upload_url_issued` / `outbound_attachment_send_failed` / `outbound_attachment_key_rejected` を既存規約で追加。メトリクス・アラームなし

## Technical Context

**Language/Version**: TypeScript 5.x / Node.js (`nodejs22.x` Lambda)。001〜009 と同一。
**Package Manager**: npm。
**HTTP クライアント方針**: グローバル `fetch` のみ (ブラウザの S3 PUT も `fetch`)。axios 系の新規導入禁止。

**Primary Dependencies**:
- app: 追加依存**なし** (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` は 009 で導入済み。PutObjectCommand の presign と HeadObjectCommand を追加使用するのみ)
- webhook / ai-worker: 変更なし

**Infrastructure** (Terraform 変更あり — 小):
- `modules/app-lambda`: IAM に `s3:PutObject` (`${media_bucket_arn}/*`) を追加 (presigned PUT の署名者権限)。env / memory / timeout 変更なし
- `envs/review/main.tf`: media バケットに `aws_s3_bucket_cors_configuration` を新設 (PUT / `https://${var.domain_name}` origin / content-type ヘッダ)
- 新規バケット・SSM・Meta App 管理画面の作業なし

**Storage**: DB スキーマ変更ゼロ・マイグレーションなし。S3 は既存 `fumireply-review-media` に `outbound/` セグメントのキーが増えるのみ。孤児オブジェクト (未送信離脱) の掃除は #78 に合流。

**Testing & CI**:
- vitest (app): `create-upload-url.server` (allowlist/サイズ/ウィンドウ/未設定環境/キー採番形式) / `send-reply.server` 拡張 (s3Key 検証・HeadObject 検証・2 通逐次と順序・部分失敗・共有 deadline による切り詰め・timeout→meta_error 写像・echo claim 回復がパーツ単位で働く・attachment 省略時の完全後方互換) / `messenger` の画像ペイロード形状・deadline による試行切り詰め・エラーマッピング共用
- vitest (app, 統合): 既存 `send-reply` 統合テストのモック DB を拡張し 2 行 INSERT・attachments JSONB 形状を検証
- Playwright E2E スモーク: 添付ボタン表示 (実行環境の `MEDIA_BUCKET_NAME` 設定が前提 = env 駆動。seed では制御不可) と client バリデーションエラー表示。**注意**: 現状 `tests/e2e/` は seed+login CI 未整備で `describe.skip` のため、E2E は best-effort 扱いとし、ハーネス整備は別作業。client 検証エラーのスモーク自体は S3 不要
- 既存 Stop フック (typecheck + lint) は変更なしで通ること

**Target Platform**: AWS Lambda + CloudFront / Supabase (001〜009 と同一)。ブラウザから S3 への直接 PUT が新規経路 (CORS で許可)。

**Project Type**: app (TanStack Start) + Terraform の 2 面拡張。webhook / ai-worker は無変更。

**Performance Goals**:
- アップロードは S3 直接のため app Lambda を経由せず、サイズによらず server fn レイテンシに影響しない
- 画像送信 1 通あたりの Meta 呼び出しは従来のテキスト送信と同一プロファイル。実測リトライラダー (research D3): 1 通最悪 ~17s (5xx 連続) / ~10.5s (timeout 経路)。presigned GET/PUT の発行はローカル署名 <1ms

**Constraints**:
- **Lambda 30s と 2 通送信**: 2 通ぶんのリトライ (実測最悪 ~17s×2=34s) が Lambda 30s を超えると 2 通目が pending 放置になり得る (008 の再発)。`SEND_TOTAL_BUDGET_MS=25s` の**共有 deadline** を両パーツの `sendMessengerReply` に渡し、残余で試行を切り詰めて 2 通合計を予算内に収める。予算切れは terminal failure (`meta_error`) で確定し pending を残さない (research D4 / 008 D2 と同じ思想)
- **サイズ・型の強制点**: client (UX) → **presigned PUT に署名した `ContentType`+`ContentLength` を S3 が強制** (型+サイズをアップロード時点で拒否) → 送信時 HeadObject (送信時点の最終確認)。presigned PUT でサイズを強制する設計 (research D1、悪用/コスト対策)
- **テナント分離**: キーはサーバー採番のみ、送信時に `^{tenantId}/{conversationId}/outbound/{uuid}/0$` を検証、表示側の既存 `toUrl` 検証と二重 (FR-010/011)
- **後方互換**: `sendReplyFn` の `attachment` 省略時は入出力・DB 書き込みとも従来と完全一致。既存クライアント/テストに影響なし (contracts §10)
- **webp**: Meta 側の受理可否が公式ドキュメントで確認できなかったため quickstart の実機検証項目。拒否される場合は allowlist 定数から除外 (research D5)
- **デプロイ順序**: terraform (IAM + CORS) → app。逆順でもアップロードが CORS で失敗するだけでテキスト送信は無影響 (quickstart)

**Scale/Scope**:
- 追加・変更コード LOC 目安: ~600 行
  - `app/src/server/services/media-upload.ts` (NEW: 定数 + presigned PUT 発行 (ContentType+ContentLength 署名) + HeadObject 検証 + キー採番/検証) ~90 行
  - `app/src/routes/(app)/threads/$id/-lib/create-upload-url.fn.ts` + `.server.ts` (NEW) ~70 行
  - `app/src/routes/(app)/threads/$id/-lib/send-reply.fn.ts` + `send-reply.server.ts` (MODIFY: attachment 入力 + parts 逐次送信 + 共有 deadline。本番ロジックは fn.ts にインライン、server.ts はテスト用の別実装 → 両方書き換え、可能なら共有ヘルパーに収束 — レビュー M-1) ~130 行
  - `app/src/server/services/messenger.ts` (MODIFY: 画像 attachment ペイロード + optional deadlineMs で試行切り詰め) ~35 行
  - `app/src/routes/(app)/threads/$id/-lib/get-conversation.fn.ts` (MODIFY: mediaUploadEnabled) ~5 行
  - `app/src/routes/(app)/threads/$id/-components/ReplyForm.tsx` (MODIFY: 添付ボタン/プレビュー/アップロード状態機械/部分失敗表示) ~150 行
  - `app/messages/{ja,en}.json` (~7 キー × 2) ~14 行
  - app tests (unit + 統合 + E2E スモーク) ~180 行
  - terraform (IAM 1 statement + CORS ブロック + 変数) ~40 行

## Constitution Check

*GATE: Phase 0 前にパス、Phase 1 設計後に再チェック。*

**プロジェクト憲法の状態**: `.specify/memory/constitution.md` 未ラティファイ (テンプレ状態)。001〜009 同様、業界標準ゲートを暫定適用する。

| ゲート | 判定 | 根拠 |
|---|---|---|
| **YAGNI** | ✅ PASS | 複数枚添付・video/audio/file/sticker 送信・画像加工・Attachment Upload API・アップロード管理テーブル・孤児掃除 (→#78) を明示除外。新規テーブル 0、新規バケット 0、webhook 変更 0 |
| **単一責任** | ✅ PASS | アップロード URL 発行/検証は `media-upload.ts`、Meta ペイロードは `messenger.ts`、送信編成は `send-reply.server.ts`、表示は既存のまま。009 の read (`media-url.ts`) / write 対称構造を維持 |
| **テスト可能性** | ✅ PASS | S3 は `aws-sdk-client-mock`、Meta は既存の fetch モックで、`.server.ts` 分離パターンにより純関数的に検証可能。既存 send-reply テストの拡張で回帰も固定 |
| **シンプル優先** | ✅ PASS | 新規 npm 依存 0、マイグレーション 0、新規インフラは IAM 1 statement + CORS 1 ブロック。presigned URL は鍵管理不要 |
| **観測性** | ✅ PASS | `outbound_*` 3 イベントを既存規約で追加、Logs Insights で集計可 (quickstart にクエリ)。成功系は DB で集計 |
| **可逆性** | ✅ PASS | app コードロールバックで旧挙動 (テキストのみ) に完全復帰。attachments 付き outbound 行は 009 の表示コードがそのまま描画でき、旧コードにも無害。IAM/CORS は残置無害 |

**複雑性の正当化**: 不要。

**Phase 1 設計後の再チェック (2026-07-20)**: 全 6 ゲート PASS 維持。data-model で DB 変更ゼロを確認、contracts で後方互換 (attachment 省略時の完全一致) と時間予算による pending 放置防止を契約化。

## Project Structure

### Documentation (this feature)

```text
specs/010-outbound-media/
├── spec.md                       # 仕様書
├── plan.md                       # 本ファイル
├── research.md                   # Phase 0 (presigned PUT 直接アップロード / payload.url 方式 / outbound キー / 2 通送信と時間予算 / 25MB・webp / echo 整合)
├── data-model.md                 # Phase 1 (DB 変更ゼロ / outbound attachments 値パターン / Pre-upload は S3 のみ / 不変条件 5 つ)
├── quickstart.md                 # Phase 1 (terraform → app デプロイ順序 / 手動検証 8 項目 (webp 含む) / Logs Insights クエリ / 孤児確認)
├── contracts/
│   └── outbound-media.md         # 定数 / createUploadUrlFn / S3 PUT / sendReplyFn 拡張 / Meta ペイロード / UI 状態機械 / ログ / IAM・CORS 差分 / 互換性
└── checklists/
    └── requirements.md           # 品質チェックリスト (specify で作成済み)
```

### Source Code (変更/追加ファイル中心)

```text
app/
├── src/
│   ├── server/
│   │   └── services/
│   │       ├── media-upload.ts                # NEW: 定数 / buildOutboundKey / presign PUT / verifyUploadedObject (HeadObject)
│   │       └── messenger.ts                   # MODIFY: 画像 attachment ペイロード対応 (共通エラーマッピング)
│   └── routes/(app)/threads/$id/
│       ├── -lib/create-upload-url.fn.ts       # NEW: server fn (auth + zod)
│       ├── -lib/create-upload-url.server.ts   # NEW: 純ロジック (テスト対象)
│       ├── -lib/send-reply.fn.ts              # MODIFY: attachment 入力
│       ├── -lib/send-reply.server.ts          # MODIFY: parts 逐次送信 + 時間予算 + s3Key/Head 検証
│       ├── -lib/get-conversation.fn.ts        # MODIFY: mediaUploadEnabled フラグ
│       └── -components/ReplyForm.tsx          # MODIFY: 添付ボタン / プレビュー / アップロード / 部分失敗表示
├── messages/{ja,en}.json                      # MODIFY: thread_attach_* キー追加
└── src/test / tests/                          # MODIFY/NEW: unit・統合・E2E スモーク

terraform/
├── envs/review/main.tf                        # MODIFY: media バケット CORS 設定
└── modules/app-lambda/main.tf                 # MODIFY: IAM s3:PutObject 追加
```

**Structure Decision**: 書き込み系ユーティリティを `media-upload.ts` に新設し、009 の読み取り系 `media-url.ts` と対称に保つ (webhook 側 `media.ts` = 受信書き込み、app 側 upload = 送信書き込み)。

送信編成 (2 通逐次 + 共有 deadline) の実装について、**現状のコード実態を踏まえた注意** (レビュー M-1): 本番の送信ロジックは `send-reply.fn.ts` の handler にインライン実装されており、`send-reply.server.ts` の `handleSendReply` はテスト専用の別実装で本番からは呼ばれていない (fn.ts は定数と型しか import しない)。したがってパーツ化は「server.ts だけ直せば済む」ものではなく**両ファイルを書き換える**。実装時は、パーツ 1 件を処理する共有ヘルパー (pending INSERT → deadline 付き送信 → TX2 確定 + echo claim 回復) に括り出し、fn.ts とテスト用ロジックの二重実装を可能な範囲で収束させる方針とする。

webhook / ai-worker / ThreadMessages に手を入れないことで、変更面を「送信経路 + 返信フォーム + インフラ 2 点」に限定する。

## Complexity Tracking

> 不要 (Constitution Check で違反なし)。
