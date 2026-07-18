---
description: "Tasks for 009 — 受信画像・添付メディアの S3 永続保存とスレッド表示"
---

# Tasks: 受信画像・添付メディアの永続保存とスレッド表示

**Input**: Design documents from `/specs/009-media-attachments/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/media-pipeline.md, quickstart.md

**Tests**: 含む。`classifyAttachments` / `downloadAttachment` の純粋 unit、webhook handler の添付保存 8 ケース (画像成功 / 複数 / 失敗リトライ / 超過スキップ / video・audio・file 判定 / echo 添付 / sticker 非保存 / バケット未設定フェイルセーフ)、app `get-conversation.fn` の attachments マッピング 3 ケース、Playwright E2E スモーク 1 本 (プレースホルダ + 種別ラベル)。

**Organization**: User Story 単位でフェーズ分割。US1 (受信画像の永続保存 + `<img>` 表示) が MVP。US2 (video/audio/file/sticker/unknown の種別ラベル + echo 添付) は `classifyAttachments` の判定表を広げて UI ラベルを足す派生。US3 (取得不可プレースホルダ + レガシー行) は失敗経路の受け皿と一度きりのデータ移行検証。Foundational (Phase 2) で Terraform / マイグレーション / `media.ts` / `classifyAttachments` / `media-url.ts` を先に完成させ、各 US はその呼び出しと表示に集中する。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並列実行可（異なるファイルで未完依存なし）
- **[Story]**: US1 / US2 / US3（Setup / Foundational / Polish フェーズには付けない）
- 各タスクに具体ファイルパスを含む
- チェックボックス: `[x]` 完了 / `[ ]` 未着手

## Path Conventions

- TanStack Start アプリ本体: `app/src/`、integration テスト: `app/tests/integration/`、E2E: `app/tests/e2e/`
- Webhook Lambda: `webhook/src/`、テストは同居 (`*.test.ts`)
- DB マイグレーション: `app/src/server/db/migrations/`
- Terraform: `terraform/envs/review/`、`terraform/modules/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: AWS SDK S3 系パッケージの追加のみ。SSM / Meta App 設定の追加はゼロ。

<!-- unit: U1.1 | deps: none | scope: setup | tasks: T001-T002 | files: 4 | automation: auto -->
**Unit U1.1 (Setup PR)**: 依存追加 2 ファイル + lockfile。最小レビューでマージ可能。

- [x] T001 Add `@aws-sdk/client-s3` to `dependencies` in `webhook/package.json` and run `npm install` in `webhook/`. esbuild build は既存どおり `@aws-sdk/*` を external 化するためバンドルサイズは不変 (Lambda 同梱 SDK を利用)。
- [x] T002 [P] Add `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `dependencies` in `app/package.json` and run `npm install` in `app/`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 全 US が依存する 5 つの土台 — (a) S3 バケット + IAM + env (Terraform)、(b) `messages.attachments` マイグレーション + 両スキーマ同期、(c) ダウンロード/保存サービス `media.ts`、(d) 種別判定 `classifyAttachments`、(e) presign ラッパ `media-url.ts`。

**⚠️ CRITICAL**: T006 (マイグレーション) 未完だと全 US の INSERT/SELECT が動かない。T003〜T005 (Terraform) は手動 `terraform apply` を伴うため最初に着手する。

<!-- unit: U2.1 | deps: U1.1 | scope: infra | tasks: T003-T005 | files: 5 | automation: manual-apply -->
**Unit U2.1 (Terraform PR)**: media バケット + webhook/app 両モジュールの IAM・env・Lambda リソース変更。`terraform plan` の出力を PR に貼る。apply は人手 (quickstart.md §1)。LOC 概算 ~120。

- [x] T003 Add media bucket resources to `terraform/envs/review/main.tf` per contracts/media-pipeline.md §6: `aws_s3_bucket` (name `${local.name_prefix}-media` → `fumireply-review-media`) + `aws_s3_bucket_public_access_block` (全 true) + `aws_s3_bucket_server_side_encryption_configuration` (AES256)。versioning・lifecycle は作らない (spec Q1, #78)。既存 artifacts バケット (main.tf:36-72) のインライン方式に倣う。モジュール呼び出しに `media_bucket_name` / `media_bucket_arn` を渡す。
- [x] T004 [P] Update `terraform/modules/webhook-lambda/{variables.tf,main.tf}`: add variables `media_bucket_name` / `media_bucket_arn`; IAM inline policy に `s3:PutObject` on `"${var.media_bucket_arn}/*"` を追加 (`s3:ListBucket` は付けない); env に `MEDIA_BUCKET_NAME`; `memory_size` 512→1024; `timeout` 10→20 (research.md R6)。
- [x] T005 [P] Update `terraform/modules/app-lambda/{variables.tf,main.tf}`: add same variables; IAM に `s3:GetObject` on `"${var.media_bucket_arn}/*"`; env に `MEDIA_BUCKET_NAME`。

<!-- unit: U2.2 | deps: U1.1 | scope: db | tasks: T006-T007 | files: 4 | automation: auto -->
**Unit U2.2 (DB PR)**: `attachments jsonb` 列追加 + レガシー body クリーンアップの migration 0004、webhook 側複製スキーマ同期。LOC 概算 ~30。

- [x] T006 Add `attachments: jsonb('attachments').$type<MessageAttachment[] | null>()` to `messages` in `app/src/server/db/schema.ts` (data-model.md の `MessageAttachment` interface を同ファイルに export)。`cd app && npx drizzle-kit generate` で `app/src/server/db/migrations/0004_*.sql` を生成し、同ファイル末尾に `--> statement-breakpoint` + `UPDATE "messages" SET "body" = '' WHERE "message_type" = 'image' AND "body" LIKE 'http%';` を手動追記 (FR-004a, 0001_rls.sql に手書き前例)。
- [x] T007 [P] Sync `webhook/src/db/schema.ts` — 同一の `attachments` 列定義と `MessageAttachment` 型を追加 (両ファイルが同一 DB を指す複製スキーマ方式を維持)。

<!-- unit: U2.3 | deps: U1.1 | scope: backend | tasks: T008-T012 | files: 6 | automation: auto -->
**Unit U2.3 (Media Foundation PR)**: `media.ts` (DL + 25MB ガード + PutObject) / `classifyAttachments` (種別判定表) / `media-url.ts` (presign) を unit テスト付きで追加。handler への組み込みは US1 以降。LOC 概算 ~200 + tests ~150。

- [x] T008 Create `webhook/src/services/media.ts` per contracts/media-pipeline.md §2: `downloadAttachment(url, { maxBytes: 26_214_400, timeoutMs: 8_000 })` — `fetch` + `AbortSignal.timeout`、`Content-Length` 超過は本文を読まず `{ ok:false, reason:'oversize' }`、ヘッダなしは reader で累積し超過時 cancel。`storeAttachment({ bucket, tenantId, conversationId, mid, index, buffer, contentType })` — `sanitizeMid` (`/[^A-Za-z0-9._-]/g` → `'_'`) でキー `{tenantId}/{conversationId}/{sanitized_mid}/{index}` を組み `PutObject` (ContentType 設定、欠落時 `application/octet-stream`)。`S3Client` はモジュールスコープで `new S3Client({ region: process.env.AWS_REGION ?? 'ap-northeast-1' })` (ssm.ts:3 の流儀)。
- [x] T009 [P] Create `webhook/src/services/media.test.ts`: `fetch` を `vi.stubGlobal`、S3 は `aws-sdk-client-mock`。ケース: Content-Length 超過で本文未読スキップ / ヘッダなしストリーミング累積超過で中断 / タイムアウト→`reason:'timeout'` / 非 2xx→`http_error` / 成功時 buffer・contentType・sizeBytes / contentType 欠落時 `application/octet-stream` / sanitizeMid のキー生成。
- [x] T010 Replace `determineMessageType` / `determineEchoMessageType` in `webhook/src/handler.ts` with exported `classifyAttachments(msg)` per contracts/media-pipeline.md §1: 判定表 (sticker_id → sticker / image・video・audio・file → そのまま / その他 → unknown)、全添付を `AttachmentPlan[]` (index, type, url, shouldStore) で返す。`messageType` = text があれば `'text'`、なければ `attachments[0].type`、添付ゼロは `'unknown'`。**body に URL は入れない** (FR-004)。既存呼び出し 2 箇所 (inbound handler.ts:101 相当 / echo 経路) は本タスクでは旧挙動を保つ最小接続に留める (添付保存の組み込みは T016 / T023)。`webhook/src/determine-echo-message-type.test.ts` は classify のテストへ置換 (T011)。
- [x] T011 [P] Create `webhook/src/classify-attachments.test.ts` (旧 `determine-echo-message-type.test.ts` を置換): text のみ / image / sticker / video / audio / file / 未知 type (`fallback`) / 複数添付の index 順 / text+添付共存で `messageType='text'` かつ attachments 併記 / url なし添付は `shouldStore:false` — の 10 ケース。
- [x] T012 [P] Add `MEDIA_BUCKET_NAME` (optional, default `''`) to `app/src/server/env.ts` and create `app/src/server/services/media-url.ts` per contracts §4: `getAttachmentUrl(s3Key): Promise<string | null>` — `GetObjectCommand` + `getSignedUrl(expiresIn: 3600)`、`MEDIA_BUCKET_NAME` 空なら `null`。`S3Client` は ssm.ts と同じ lazy singleton パターン。

**Checkpoint**: Foundation ready — US1 / US2 / US3 は並列で着手可能。

---

## Phase 3: User Story 1 - 顧客が送った画像がスレッドで画像として表示される (Priority: P1) 🎯 MVP

**Goal**: inbound 画像を受信時に S3 へ永続保存し (`attachments` JSONB 記録)、スレッド UI で presigned URL の `<img>` として表示。クリックで原寸モーダル。URL 失効後も表示できる。

**Independent Test**: webhook 単体テストで image 添付付き inbound を流し S3 PutObject + `attachments` JSONB (s3Key 非 null) + `body=''` を assert。app 側は `get-conversation.fn` が `{ index, type:'image', url }` を返し、`MessageBubble` が `<img>` を描画することを確認。手動検証は quickstart.md §手動検証 1-2 (実画像送信 → S3 オブジェクト確認 → 表示 → 原寸)。

<!-- unit: U3.1 | deps: U2.2, U2.3 | scope: backend | tasks: T013-T016 | files: 2 | automation: auto -->
**Unit U3.1 (US1 webhook PR)**: inbound 経路に classify → DL/保存 (逐次 + リトライ) → attachments INSERT を組み込み。失敗しても INSERT 成功 (FR-003)。LOC 概算 ~90 + tests ~120。

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T013 [P] [US1] Add vitest test "inbound image 添付が S3 保存され attachments に記録される" in `webhook/src/handler.test.ts`: fetch stub (画像バイト) + S3 mock で image 添付 inbound を `processMessagingEvent` へ → PutObject 1 回 (キー `{tenantId}/{convId}/{mid}/0`, ContentType) / INSERT 値 `body=''`・`messageType='image'`・`attachments=[{index:0,type:'image',s3Key:…,contentType,sizeBytes}]` / `attachment_stored` ログ (tenantId, mid, index, type, sizeBytes) を assert。
- [x] T014 [P] [US1] Add test "複数画像 (2 枚) が全件 index 順に保存される" in `webhook/src/handler.test.ts`: PutObject 2 回 (`…/0`, `…/1`)、attachments 長 2。現行「先頭 1 件のみ」の廃止を確認。
- [x] T015 [P] [US1] Add test "ダウンロード失敗 → リトライ 2 回 → s3Key null で INSERT は成功" in `webhook/src/handler.test.ts`: fetch を 3 回連続失敗させ fetch 呼び出し回数 3 / `attachments=[{…,s3Key:null}]` / メッセージ行 INSERT 成功 / `attachment_download_failed` ログ (attempts:3, reason) を assert。`MEDIA_BUCKET_NAME` 未設定ケース (fetch 0 回, reason `bucket_not_configured`) も同時に追加。

### Implementation for User Story 1

- [x] T016 [US1] Integrate media pipeline into inbound path in `webhook/src/handler.ts` per contracts §3: `classifyAttachments` の結果から `shouldStore` な添付を **トランザクション外で逐次** `downloadAttachment` (失敗時 200ms/500ms backoff で最大 3 試行、`oversize` はリトライなし) → `storeAttachment` し、確定した `MessageAttachment[]` を INSERT 値に渡す (ゼロ件は `null`)。`MEDIA_BUCKET_NAME` 未設定なら DL をスキップし全対象 `s3Key:null` + warn ログ (research.md R11)。構造化ログ 3 種は contracts §7 の fields を厳守。非テキストは従来どおり AI 下書き非発火・`onConflictDoNothing` 維持。

<!-- unit: U3.2 | deps: U2.2, U3.1 | scope: fullstack | tasks: T017-T020 | files: 5 | automation: auto -->
**Unit U3.2 (US1 app PR)**: `get-conversation.fn` の attachments 返却 + `MessageBubble` の画像表示・原寸モーダル。LOC 概算 ~170 + tests ~40。

- [x] T017 [US1] Update `app/src/routes/(app)/threads/$id/-lib/get-conversation.fn.ts`: SELECT に `attachments` を追加し、`MessageWithDraft` に `attachments: { index: number; type: string; url: string | null }[]` を追加。各要素は `s3Key` 非 null なら `getAttachmentUrl` で presigned URL、null なら `url:null`。DB `NULL` → `[]`。**`s3Key` はレスポンスに含めない** (contracts §4)。あわせて `MessageWithDraft.message_type` の union を `'text' | 'image' | 'sticker' | 'video' | 'audio' | 'file' | 'unknown'` に拡張し、旧 `'other'` フォールバックは `'unknown'` に統一する (DB 値と揃え、T028 のレガシー導出が種別を区別できるようにする)。
- [x] T018 [P] [US1] Add integration test in `app/tests/integration/conversation-fns.test.ts`: attachments 付き行 → `{ index, type, url }` 変換 (presigner はモック) / `s3Key:null` → `url:null` / `attachments` NULL → `[]` の 3 ケース。レスポンスに `s3Key` キーが存在しないことも assert。さらに `cross-tenant-connect.test.ts` のパターンで「他テナントの会話 ID で `get-conversation` を呼ぶと notFound になり presign が 1 度も呼ばれない」ケースを 1 件追加 (FR-010 / SC-006 の検証)。
- [x] T019 [US1] Update `MessageBubble` in `app/src/routes/(app)/threads/$id/-components/ThreadMessages.tsx`: `attachments` の `type='image'` + `url` を `<img src loading="lazy" alt={m.thread_attachment_image_alt()}>` (max-width 240px, border-radius, インライン style + CSS 変数の既存流儀) で表示。クリックで原寸モーダル (`position:fixed` オーバーレイ、Esc / 背景クリック / 閉じるボタン `m.thread_attachment_modal_close()` で閉じる。新規ライブラリなし)。body 非空なら本文と添付を両方表示 (spec Edge Case)。
- [x] T020 [P] [US1] Add keys to `app/messages/ja.json` and `app/messages/en.json`: `thread_attachment_image_alt`, `thread_attachment_modal_close`。`npm run paraglide:compile` が pretest で走ることを確認。

**Checkpoint**: US1 が単独で動作 — 画像受信 → S3 → `<img>` 表示までを独立検証可能 (MVP)。

---

## Phase 4: User Story 2 - 画像以外の添付も種別が分かる形で表示される (Priority: P2)

**Goal**: video / audio / file を正しく判定・保存し、sticker / unknown を含む全非テキストをスレッド上で種別ラベル表示。echo 経路の添付も同じパイプラインで保存し空バブルを根絶。

**Independent Test**: webhook 単体テストで video / audio / file / sticker / echo image の各ペイロードを流し `messageType`・S3 保存有無・attachments 記録を assert。UI は attachments type ごとのラベル文字列が描画されることを確認。手動検証は quickstart.md §手動検証 3-4, 7。

<!-- unit: U4.1 | deps: U3.1, U3.2 | scope: fullstack | tasks: T021-T025 | files: 4 | automation: auto -->
**Unit U4.1 (US2 PR)**: echo 経路への組み込み + UI 種別ラベル。判定表は U2.3 で完成済みのため接続と表示が中心。LOC 概算 ~80 + tests ~90。

### Tests for User Story 2 ⚠️

- [x] T021 [P] [US2] Add tests "video / audio / file inbound の種別と保存" in `webhook/src/handler.test.ts`: それぞれ `messageType` 正 / S3 保存 / attachments 記録 / 空バブル要素なし (`body=''`)。sticker は DL なし (`fetch` 0 回) で `[{type:'sticker',s3Key:null}]`、未知 type (`fallback`) は `unknown` 記録を assert。video/audio/file でも **SQS enqueue (AI 下書き) が呼ばれない**ことを assert (FR-014)。
- [x] T022 [P] [US2] Add tests "echo 添付の保存" in `webhook/src/handler.test.ts`: `is_echo=true` + image 添付 → S3 保存 + attachments 付き INSERT (外部送信)。既存自送信行あり (mid 衝突) の UPSERT では **SET が `sendStatus` のみ** で attachments を上書きしないこと (contracts §3)。echo の副作用なし (SQS / Summary / NameFetch 不発火) の既存 assert を維持。

### Implementation for User Story 2

- [x] T023 [US2] Integrate media pipeline into echo path in `webhook/src/handler.ts`: `determineEchoMessageType` の残置呼び出しを `classifyAttachments` + T016 と同じ DL/保存ヘルパに置換 (FR-009)。INSERT 値に attachments を追加、`onConflictDoUpdate` の SET は現行 (`sendStatus:'sent'`) を変えない。
- [x] T024 [US2] Update `MessageBubble` in `app/src/routes/(app)/threads/$id/-components/ThreadMessages.tsx`: attachments の `video` / `audio` / `file` / `sticker` / `unknown` を種別ラベル (`m.thread_attachment_video()` 等、アイコン的な絵文字 + テキストで可) で表示。`url` があっても本リリースではインライン再生・DL リンクを出さない (spec Assumptions)。
- [x] T025 [P] [US2] Add keys to `app/messages/ja.json` / `app/messages/en.json`: `thread_attachment_video`, `thread_attachment_audio`, `thread_attachment_file`, `thread_attachment_sticker`, `thread_attachment_unknown`。

**Checkpoint**: US1 + US2 — 全種別が空バブルなしで表示される。

---

## Phase 5: User Story 3 - 取得できないメディアはプレースホルダで明示される (Priority: P2)

**Goal**: 保存失敗・サイズ超過・レガシー行 (本機能以前の受信) を「画像 (取得不可)」等の明示的プレースホルダで表示。過去の body 内 CDN URL はデータ移行で除去済みであることを検証。

**Independent Test**: webhook 単体テストで 25MB 超過 → `attachment_skipped_oversize` + `s3Key:null` を assert。UI は `type='image', url:null` とレガシー行 (`attachments:[]` + `message_type='image'`) の両方でプレースホルダが出ることを確認。手動検証は quickstart.md §手動検証 5 + §2 の件数クエリ。

<!-- unit: U5.1 | deps: U3.1, U3.2 | scope: fullstack | tasks: T026-T030 | files: 4 | automation: auto -->
**Unit U5.1 (US3 PR)**: 超過スキップの handler 組み込み確認 + プレースホルダ UI + レガシー移行検証。LOC 概算 ~60 + tests ~70。

### Tests for User Story 3 ⚠️

- [x] T026 [P] [US3] Add test "25MB 超過はスキップされ attachments に取得不可で残る" in `webhook/src/handler.test.ts`: fetch stub が `Content-Length: 30MB` を返す → PutObject 0 回 / `[{type:'image',s3Key:null}]` / INSERT 成功 / `attachment_skipped_oversize` ログ / リトライなし (fetch 1 回) を assert。
- [x] T027 [P] [US3] Add integration test in `app/tests/integration/conversation-fns.test.ts`: レガシー行 (`attachments` NULL + `message_type='image'` + `body=''`) → `attachments: []` で返り、型エラーなく処理されること。

### Implementation for User Story 3

- [x] T028 [US3] Update `MessageBubble` in `app/src/routes/(app)/threads/$id/-components/ThreadMessages.tsx`: (a) `type='image'` + `url:null` → `m.thread_attachment_image_unavailable()` プレースホルダ (破線 border の控えめなボックス、インライン style)。(b) `attachments` が空かつ `message_type` 非 text のレガシー行 → `message_type` から同じプレースホルダ/種別ラベルを導出 (`image`→取得不可 / `sticker` 等→U4.1 のラベル / `unknown`→不明)。旧形式 (body=URL) の判定コードは書かない (FR-004a)。
- [x] T029 [P] [US3] Add keys to `app/messages/ja.json` / `app/messages/en.json`: `thread_attachment_image_unavailable`。
- [ ] T030 [US3] **[人手]** Verify legacy cleanup migration: レビュー環境で quickstart.md §2 の `SELECT count(*) … body LIKE 'http%'` を migration 適用前後に実行し、適用後 0 件になること・スレッド画面で該当メッセージがプレースホルダ表示になることを確認して PR に記録 (SC-002)。

**Checkpoint**: 全 US が独立に機能 — 生 URL 0 件・空バブル 0 件 (SC-002 / SC-003)。

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: 006 spec の方針記述の同期、E2E スモーク、quickstart 検証。

<!-- unit: U6.1 | deps: U4.1, U5.1 | scope: polish | tasks: T031-T034 | files: 5 | automation: auto -->
**Unit U6.1 (Polish PR)**: ドキュメント同期 + E2E。LOC 概算 ~80。

- [x] T031 [P] Sync 006 spec per spec.md Assumptions: `specs/006-message-echoes-ingest/spec.md` (Edge Cases「非テキストは body=''」/ FR-005) と `specs/006-message-echoes-ingest/research.md` の該当箇所に「009 で echo 添付も保存対象になった (種別記録 + 添付保存)」旨の追記・更新 (issue #73 記載の spec.md:67,83 / research.md:225,232-233)。コードは正、spec を実装に合わせる。
- [x] T032 [P] Add Playwright E2E smoke `app/tests/e2e/media-attachments.spec.ts`: seed (`app/src/server/db/seed/e2e.ts` に attachments 付きメッセージ fixture を追加 — `s3Key:null` の image と `sticker`) → スレッド画面で「画像 (取得不可)」プレースホルダとスタンプラベルが描画され、生 URL 文字列・空バブルが存在しないことを確認 (presign 不要なケースで E2E を成立させる)。
- [ ] T033 **[人手]** Run quickstart.md 手動検証 1-7 (実 Messenger 送信を伴うもの) をレビュー環境で実施し、結果を PR コメントに記録。CloudWatch Logs Insights で `attachment_stored` が集計できること (SC-005) を確認。
- [x] T034 Run `npm run typecheck && npm run lint` in `app/` and `webhook/`, `npm test` in both, `terraform fmt -check` in `terraform/` — 全緑を確認 (既存 Stop フックと同等)。

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: 依存なし
- **Phase 2 (Foundational)**: U2.1 (Terraform) / U2.2 (DB) / U2.3 (Media services) は相互に独立で並列可。すべて Phase 1 完了後
- **Phase 3 (US1)**: U3.1 は U2.2 + U2.3 完了後。U3.2 の着手自体は U2.2 完了後に可能だが、PR のマージ順は unit メタどおり U3.1 → U3.2 とする
- **Phase 4 (US2)**: U4.1 は U3.1 + U3.2 完了後 (同じ handler / MessageBubble を触るため直列)
- **Phase 5 (US3)**: U5.1 は U3.1 + U3.2 完了後。U4.1 とはファイルが重なる (`ThreadMessages.tsx` / `handler.test.ts`) ため同時着手は避け、U4.1 → U5.1 の順を推奨
- **Phase 6 (Polish)**: 全 US 完了後

### User Story Dependencies

- **US1 (P1)**: Foundational のみに依存 — MVP として単独デプロイ可
- **US2 (P2)**: US1 の handler 組み込み (T016) を echo へ展開。US1 完了後
- **US3 (P2)**: US1 の失敗経路とプレースホルダ UI の受け皿。US1 完了後 (US2 とは独立だが同一ファイル編集のため順次)

### Parallel Opportunities

- T001 ∥ T002 (別パッケージ)
- T003→(T004 ∥ T005)、U2.1 ∥ U2.2 ∥ U2.3 (別領域)
- U2.3 内: T008→(T009 ∥ T010)→T011、T012 は全体と並列
- US1 内: T013 ∥ T014 ∥ T015 (テスト先行)、T018 ∥ T020
- US2 内: T021 ∥ T022、T025 は実装と並列
- Polish: T031 ∥ T032

---

## Implementation Strategy

### MVP First (US1 のみ)

1. Phase 1 → Phase 2 (Terraform apply + migration は quickstart.md の順序で人手確認)
2. Phase 3 (US1) 完了 → 画像の受信・保存・表示を独立検証 → デプロイ可能な MVP
3. **STOP and VALIDATE**: quickstart 手動検証 1-2, 6 を実施

### Incremental Delivery

1. U1.1 → U2.1 / U2.2 / U2.3 (並列 3 PR) → 土台完成
2. U3.1 → U3.2 → **MVP デプロイ** (画像が表示される)
3. U4.1 → 全種別ラベル + echo 添付
4. U5.1 → プレースホルダ + レガシー移行検証
5. U6.1 → spec 同期 + E2E + 検証記録

---

## Notes

- [P] = 別ファイル・未完依存なし。`ThreadMessages.tsx` と `handler.test.ts` は US2 / US3 で共有されるため story 間の同時編集を避ける
- 各 Unit = 1 PR。コミットはタスクまたは論理グループ単位
- webhook のテストは既存 `handler.test.ts` の `vi.hoisted` + `aws-sdk-client-mock` + `setupEchoTx` パターンを踏襲する
- Terraform apply / DB migrate / デプロイの順序と部分デプロイ時のフェイルセーフは research.md R11 / quickstart.md 参照
