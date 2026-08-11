---
description: "Tasks for 010 — 送信側メディア添付 (オペレーターから顧客への画像送信)"
---

# Tasks: 送信側メディア添付 — オペレーターから顧客への画像送信

**Input**: Design documents from `/specs/010-outbound-media/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/outbound-media.md, quickstart.md

**Tests**: 含む。`media-upload` の純粋 unit (キー採番/検証・presign 引数・Head 検証)、`messenger` の画像ペイロード + deadline 切り詰め、`create-upload-url.server` (allowlist/サイズ/ウィンドウ/未設定/キー形式)、`send-reply.server` 拡張 (s3Key 検証・Head 検証・parts 逐次と順序・共有 deadline・timeout→meta_error・部分失敗・echo claim・後方互換)、統合テスト (2 行 INSERT + attachments JSONB)、Playwright E2E スモーク (添付ボタン + client 検証エラー、ハーネスは best-effort)。

**Organization**: User Story 単位でフェーズ分割。US1 (画像単独送信 + outbound バブル表示) が MVP。US2 (テキスト+画像の 2 通逐次) は US1 で作った parts ループ + 共有 deadline を UI から使い切る派生。US3 (検証・失敗フィードバック・再送) は失敗経路の受け皿。Foundational (Phase 2) で `media-upload.ts` / `messenger.ts` 拡張 / Terraform を先に完成させ、各 US はその配線と UI に集中する。DB スキーマ変更・webhook 変更・新規依存はゼロ (009 の資産を再利用)。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並列実行可（異なるファイルで未完依存なし）
- **[Story]**: US1 / US2 / US3（Setup / Foundational / Polish フェーズには付けない）
- 各タスクに具体ファイルパスを含む
- チェックボックス: `[x]` 完了 / `[ ]` 未着手

## Path Conventions

- TanStack Start アプリ本体: `app/src/`、server fn: `app/src/routes/(app)/threads/$id/-lib/`、UI: 同 `-components/`
- 共有サービス: `app/src/server/services/`、integration テスト: `app/tests/integration/`、E2E: `app/tests/e2e/`
- Terraform: `terraform/envs/review/`、`terraform/modules/app-lambda/`
- webhook / ai-worker / DB マイグレーションは本機能では変更なし

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 新規 npm 依存・マイグレーション・SSM・Meta App 設定はいずれもゼロ (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` は 009 で導入済み)。着手前の前提確認のみ。

<!-- unit: U1.1 | deps: none | scope: setup | tasks: T001 | files: 0 | automation: auto -->
**Unit U1.1 (Preflight)**: 依存・スキーマの現状確認のみ。コード変更なし。

- [x] T001 前提確認: `app/package.json` に `@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner` が存在すること、`app/src/server/db/schema.ts` の `messages.attachments jsonb` と `MessageAttachment` 型 (009) が存在すること、`app/src/server/env.ts` に `MEDIA_BUCKET_NAME` があることを確認する。いずれも欠けていれば 009 のマージ漏れなので先に解消する (新規追加はしない)。

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 全 US が依存する 3 つの土台 — (a) アップロード書き込みユーティリティ `media-upload.ts` (定数 + キー採番/検証 + presigned PUT 発行 + HeadObject 検証)、(b) `messenger.ts` の画像ペイロード + 共有 deadline 対応、(c) Terraform (app-lambda IAM `s3:PutObject` + media バケット CORS)。

**⚠️ CRITICAL**: T002 (`media-upload.ts`) は US1〜US3 の全 server fn が import する。T004 (Terraform) は手動 `terraform apply` を伴うため早めに着手する。

<!-- unit: U2.1 | deps: U1.1 | scope: backend | tasks: T002-T003 | files: 2 | automation: auto -->
**Unit U2.1 (Upload Utility PR)**: `media-upload.ts` を unit テスト付きで新設。LOC 概算 ~90 + tests ~90。

- [x] T002 Create `app/src/server/services/media-upload.ts` per contracts/outbound-media.md §1〜§4: 定数 `ALLOWED_IMAGE_TYPES` / `MAX_ATTACHMENT_BYTES=26_214_400` / `UPLOAD_URL_EXPIRES_IN=300` / `SEND_TOTAL_BUDGET_MS=25_000` / `SEND_MIN_ATTEMPT_MS=1_500`。`buildOutboundKey(tenantId, conversationId)` → `{tenantId}/{conversationId}/outbound/{crypto.randomUUID()}/0`。`isValidOutboundKey(key, tenantId, conversationId)` → 正規表現 `^{tenantId}/{conversationId}/outbound/[0-9a-f-]{36}/0$` 判定。`presignUploadUrl({ bucket, key, contentType, sizeBytes })` → `PutObjectCommand` に **`ContentType` と `ContentLength: sizeBytes` を含めて署名** (research D1) し `getSignedUrl(expiresIn: UPLOAD_URL_EXPIRES_IN)`。`verifyUploadedObject({ bucket, key })` → `HeadObjectCommand` で `{ contentType, contentLength }` を返し、存在しなければ `null`。`S3Client` は `media-url.ts` と同じ lazy singleton / region 方針。
- [x] T003 [P] Create `app/src/server/services/media-upload.test.ts`: `aws-sdk-client-mock` で S3 をモック。ケース — `buildOutboundKey` がプレフィックス + UUID + `/0` 形式を返す / `isValidOutboundKey` が自会話キーを通し他テナント・他会話・`outbound` 以外・UUID 不正・index≠0 を弾く / `presignUploadUrl` が署名済み URL に `ContentType`・`ContentLength` を含む (署名ヘッダ or クエリを検証) / `verifyUploadedObject` が Head の値を返す・NoSuchKey で `null`。

<!-- unit: U2.2 | deps: U1.1 | scope: backend | tasks: T004a-T004b | files: 2 | automation: auto -->
**Unit U2.2 (Messenger Image + Deadline PR)**: `messenger.ts` に画像バリアントと deadline 切り詰めを追加。テキスト送信は完全後方互換。LOC 概算 ~35 + tests。

- [x] T004a Extend `app/src/server/services/messenger.ts` per contracts §5: `sendMessengerReply` の `message` 部を判別 union 化 (`{ text }` | `{ imageUrl }`) するか `sendMessengerImage` を追加し、画像は `message:{ attachment:{ type:'image', payload:{ url, is_reusable:false } } }` を送る。optional `deadlineMs?: number` を追加 — 各試行前に `remaining = deadlineMs - Date.now()`、`remaining < SEND_MIN_ATTEMPT_MS` なら残り試行を打ち切り `{ ok:false, error:'timeout' }`、そうでなければ fetch timeout を `AbortSignal.timeout(min(TIMEOUT_MS, remaining))` にクランプ。`deadlineMs` 省略時は現行と完全同一挙動。エンドポイント・エラーマッピング・`message_id` 取得は共通。
- [x] T004b [P] Extend `app/src/server/services/messenger.test.ts`: 画像ペイロード形状 (`attachment.type='image'`, `payload.url`) / deadline 残余で fetch timeout がクランプされる / `remaining < SEND_MIN_ATTEMPT_MS` で Meta を呼ばず `timeout` を返す / `deadlineMs` 省略時は既存テストどおり。既存テストが無変更で通ること。

<!-- unit: U2.3 | deps: U1.1 | scope: infra | tasks: T005-T006 | files: 3 | automation: manual-apply -->
**Unit U2.3 (Terraform PR)**: app-lambda IAM に `s3:PutObject` 追加 + media バケット CORS。`terraform plan` を PR に貼り apply は人手 (quickstart §1)。LOC 概算 ~40。

- [x] T005 Update `terraform/modules/app-lambda/main.tf` per contracts §9: 既存 IAM statement `S3GetMediaObject` の `actions` に `s3:PutObject` を追加 (対象は `"${var.media_bucket_arn}/*"`、`ListBucket` は付けない)。HeadObject は既存 `s3:GetObject` でカバー。変数・env・memory・timeout は変更なし。
- [x] T006 [P] Add `aws_s3_bucket_cors_configuration.media` to `terraform/envs/review/main.tf` per contracts §9: `cors_rule` = `allowed_methods=["PUT"]`, `allowed_origins=["https://${var.domain_name}"]`, `allowed_headers=["content-type"]`, `max_age_seconds=3600`。開発用 origin を足せるよう変数化を検討 (任意)。

**Checkpoint**: Foundation ready — US1 に着手可能。US2/US3 は US1 の parts ループ・UI を土台にするため US1 完了後。

---

## Phase 3: User Story 1 - オペレーターが画像を添付して送信できる (Priority: P1) 🎯 MVP

**Goal**: スレッドの返信フォームから画像 1 枚を添付 → S3 直接アップロード → 送信すると顧客の Messenger に画像が届き、自社スレッドの outbound バブルにも表示される。

**Independent Test**: jpeg を 1 枚添付して送信し、(1) 顧客役の Messenger に画像到着、(2) 自社スレッド outbound バブルにサムネイル + クリックで原寸、(3) 7 秒ポーリング後・再訪問後も安定表示、を確認 (quickstart 手順 1)。

<!-- unit: U3.1 | deps: U2.1 | scope: backend | tasks: T007-T008 | files: 3 | automation: auto -->
**Unit U3.1 (Upload URL fn PR)**: 事前アップロード URL 発行の server fn を新設。LOC 概算 ~70 + tests。

- [x] T007 Create `app/src/routes/(app)/threads/$id/-lib/create-upload-url.server.ts` + `create-upload-url.fn.ts` per contracts §2: Input zod `{ conversationId: uuid, contentType: enum(ALLOWED_IMAGE_TYPES), sizeBytes: int 1..MAX_ATTACHMENT_BYTES }`。`authMiddleware` + `withTenant` で会話帰属を検証 (無ければ `not_found`)、24h ウィンドウ検証 (`lastInboundAt`、期外 `outside_window`)、`MEDIA_BUCKET_NAME` 未設定なら `not_configured`。`buildOutboundKey` でキー採番 → `presignUploadUrl` で PUT URL 発行。`outbound_upload_url_issued` を info ログ。Output `{ ok:true, s3Key, uploadUrl } | { ok:false, error }`。純ロジックは `.server.ts`、fn は委譲。
- [x] T008 [P] [US1] Create `app/src/routes/(app)/threads/$id/-lib/create-upload-url.fn.test.ts`: allowlist 外 contentType / sizeBytes 超過・0 / 会話が別テナント → not_found / ウィンドウ外 → outside_window / MEDIA_BUCKET_NAME 未設定 → not_configured / 正常系でキー形式 + presign 呼び出し。`media-upload` はモック or 実関数 + S3 mock。

<!-- unit: U3.2 | deps: U2.1,U2.2,U3.1 | scope: backend | tasks: T009-T011 | files: 3 | automation: auto -->
**Unit U3.2 (Send image PR)**: `sendReplyFn` を attachment 対応に拡張 + parts 処理ヘルパーを新設 (画像単独送信を成立させる)。LOC 概算 ~130 + tests。

- [x] T009 [US1] Extend Input + 共有ヘルパー: `send-reply.fn.ts` の zod を `{ conversationId, body: string(trim), attachment?: { s3Key } }` にし `body` か `attachment` の一方必須 (`refine`)。パーツ 1 件を処理する共有ヘルパー `processSendPart(tx, ctx, deadlineMs, part)` を抽出 — pending INSERT (image パーツは `messageType:'image'`, `body:''`, `attachments:[{index:0,type:'image',s3Key,contentType,sizeBytes}]`) → `sendMessengerReply(..., deadlineMs)` → TX2 (sent+metaMessageId / failed+sendError、`timeout`→`meta_error` 写像、mid unique 衝突の echo claim 回復)。**本番は `fn.ts` インライン・`server.ts` はテスト用の別実装**なので両方に反映 (contracts M-1 注記)。
- [x] T010 [US1] Wire attachment path in `send-reply.fn.ts` per contracts §4: attachment ありのとき — `isValidOutboundKey` 検証 (不一致 → `validation_failed` + `outbound_attachment_key_rejected` warn)、`verifyUploadedObject` (存在/ContentType allowlist/サイズ ≤ MAX、外れは `validation_failed`)、`MEDIA_BUCKET_NAME` 未設定は `validation_failed`。`deadlineMs = Date.now() + SEND_TOTAL_BUDGET_MS` を確定し、parts = `[image]` (US1 は body 空前提) を `processSendPart` で処理。成功時に `lastMessageAt` 更新 / draft dismiss / `maybeEnqueueSummaryJob` を 1 回。presigned GET は `getAttachmentUrl(s3Key)`。`send-reply.server.ts` (テスト用) にも同等反映。**attachment 省略時は入出力・DB とも従来と完全一致** (contracts §10)。
- [x] T011 [P] [US1] Extend `send-reply.fn.test.ts` (+ `send-reply.server.ts` の unit): 画像単独送信で `messageType='image'`/`body=''`/`attachments` が入る・Meta に画像ペイロード・`sent`+metaMessageId / 不正 s3Key で `validation_failed` + key_rejected ログ / Head 検証失敗で `validation_failed` / echo claim がパーツで働く / **attachment 省略時に既存アサート (`result.message.*`) が無変更で通る**。

<!-- unit: U3.3 | deps: U2.1 | scope: backend | tasks: T012 | files: 1 | automation: auto -->
**Unit U3.3 (mediaUploadEnabled flag PR)**: 表示 fn にフラグを additive 追加。LOC 概算 ~5 + テスト調整。

- [x] T012 [US1] Add `mediaUploadEnabled: Boolean(env.MEDIA_BUCKET_NAME)` to the `getConversationFn` response in `app/src/routes/(app)/threads/$id/-lib/get-conversation.fn.ts` (contracts §6, research D6)。`ConversationDetail` 型に additive で追加し既存フィールドは不変。`app/tests/integration/conversation-fns.test.ts` にフラグ検証を 1 ケース追加。

<!-- unit: U3.4 | deps: U3.1,U3.2,U3.3 | scope: frontend | tasks: T013-T015 | files: 3 | automation: auto -->
**Unit U3.4 (ReplyForm image send PR)**: 返信フォームに添付 → アップロード → 画像送信を実装。LOC 概算 ~120 + i18n。

- [x] T013 [US1] Add attachment UI to `app/src/routes/(app)/threads/$id/-components/ReplyForm.tsx` per contracts §7: `mediaUploadEnabled && !isWindowClosed` のとき 📎 ボタン (`<input type="file" accept="image/*">`) を表示。選択で `createUploadUrlFn` → S3 直接 `PUT` (`fetch`, `content-type` ヘッダ)。状態機械 `idle→picked→uploading→ready`、`URL.createObjectURL` プレビュー + 取り消し (revoke 忘れず)。`props` に `mediaUploadEnabled` を通す (`index.tsx` の受け渡し追加)。
- [x] T014 [US1] Relax send guards + wire image send in `ReplyForm.tsx` per contracts §7 (レビュー M-3): `handleSubmit` early-return (現 `:162`)・送信ボタン `disabled`/`aria-disabled` (`:477-478`)・`background`/`cursor` (`:488-489`) を `!body.trim() && !attachment` に緩める。送信時 `sendReplyFn({ conversationId, body, attachment: { s3Key } })` を呼び、成功で body/添付をクリアし `router.invalidate()`。
- [x] T015 [P] [US1] Add i18n keys to `app/messages/ja.json` + `app/messages/en.json`: `thread_attach_image` / `thread_attach_remove` / `thread_attach_invalid_type` / `thread_attach_too_large` / `thread_attach_upload_failed` / `thread_attach_partial_failure` (contracts §7、命名は既存 `reply_error_*` 規約に合わせる)。`npm run paraglide:compile` が通ること。

**Checkpoint**: 画像単独送信が end-to-end で動作 (MVP)。顧客に届き、自社スレッドにも表示される。

---

## Phase 4: User Story 2 - テキストと画像を同時に送信できる (Priority: P2)

**Goal**: テキスト+画像を入力して送信すると、テキスト → 画像の順で 2 通届き、自社スレッドにも 2 メッセージとして表示され、各々の成否が個別に分かる。

**Independent Test**: テキストと画像を両方入れて送信 → 顧客側にテキスト → 画像の 2 通 → 自社スレッドに 2 メッセージ (quickstart 手順 3)。部分失敗時に「どこまで届いたか」が UI で判別できる。

<!-- unit: U4.1 | deps: U3.2 | scope: backend | tasks: T016-T017 | files: 3 | automation: auto -->
**Unit U4.1 (Parts loop PR)**: `sendReplyFn` を 2 パーツ逐次 + 共有 deadline に一般化。LOC 概算 ~50 + tests。

- [x] T016 [US2] Generalize `send-reply.fn.ts` (+ `server.ts`) to sequential parts per contracts §4 / research D4: parts = `body ? [text, image] : [image]`。**共有 `deadlineMs` を両パーツの `sendMessengerReply` に渡す** (2 通合計を `SEND_TOTAL_BUDGET_MS` に収める)。text パーツの sent/failed 確定後に image パーツを開始 (順序保証)。1 通目失敗でも 2 通目は独立試行 (予算共有のトレードオフは D4)。`lastMessageAt`/draft dismiss/`maybeEnqueueSummaryJob` はいずれかのパーツ成功後に 1 回 (レビュー N-2)。Output に `parts: PartResult[]` を additive 付与、`message` は最後に成功したパーツ (contracts M-2)。
- [x] T017 [P] [US2] Add parts tests to `send-reply.fn.test.ts` + `app/tests/integration/send-reply.test.ts`: テキスト+画像で 2 行 INSERT (text→image の timestamp 順) / text 成功 + image 失敗で `parts` が個別成否・`ok:false`・`message` は text 行 / 共有 deadline で 1 通目が予算を食うと 2 通目が試行なしで `meta_error` / summary trigger は 1 回だけ / 統合テストで attachments JSONB 形状。

<!-- unit: U4.2 | deps: U4.1,U3.4 | scope: frontend | tasks: T018 | files: 1 | automation: auto -->
**Unit U4.2 (Combined send UI PR)**: 返信フォームでテキスト+画像同時送信と部分失敗表示。LOC 概算 ~40。

- [x] T018 [US2] Update `ReplyForm.tsx` per contracts §7: テキストと添付が両方あるとき両方を保持して送信し、レスポンスの `parts` を見て部分失敗を表示 (`thread_attach_partial_failure` — 「テキストは送信済み、画像は失敗」)。成功パーツはクリア、失敗パーツは再送可能な状態を保つ (再送の詳細は US3 T021)。

**Checkpoint**: テキスト+画像の 2 通送信が動作。US1・US2 が独立に機能する。

---

## Phase 5: User Story 3 - 送信できない場合は理由が分かり事故が起きない (Priority: P2)

**Goal**: 対応外形式・サイズ超過・期限切れ・配信失敗を明確にフィードバックし、対応外ファイルや期限切れ会話への添付を受け付けない。無言の失敗・誤送信を防ぐ。

**Independent Test**: 対応外形式 / 上限超過サイズ / 期限切れ会話 のそれぞれで、選択時エラー・操作無効化・サーバー拒否が起きることを確認 (quickstart 手順 4・5・7)。

<!-- unit: U5.1 | deps: U3.4 | scope: frontend | tasks: T019-T021 | files: 2 | automation: auto -->
**Unit U5.1 (Client validation + error mapping PR)**: 選択時検証・エラー表示・再発行/再送。LOC 概算 ~60。

- [x] T019 [US3] Add client-side validation to `ReplyForm.tsx` per contracts §7: 選択時に `ALLOWED_IMAGE_TYPES` / `MAX_ATTACHMENT_BYTES` を検証し、外れは `thread_attach_invalid_type` / `thread_attach_too_large` を即表示してアップロードに進まない (`media-upload.ts` の定数を client からも参照)。
- [x] T020 [US3] Wire error-code → i18n mapping in `ReplyForm.tsx` per contracts §7 の対応表: `createUploadUrlFn` の `outside_window`→`reply_error_outside_window` 流用 / `not_found`・`not_configured`・`validation_failed`・S3 PUT 403 → `thread_attach_upload_failed` / `sendReplyFn` のエラーは既存 `reply_error_*` マッピング流用。generic フォールバックも用意。
- [x] T021 [US3] Implement upload-URL re-issue + failed-part re-send in `ReplyForm.tsx` per contracts §3/§7 (レビュー 低-4/低-5): アップロード失敗時は古い URL/キーを捨て `createUploadUrlFn` を呼び直して再試行。part 部分失敗の再送は **失敗パーツのみ** — text 成功 + image 失敗なら body を空にして attachment だけで `sendReplyFn` を呼ぶ (テキスト二重送信防止)。成功済みテキストは入力欄からクリア。

<!-- unit: U5.2 | deps: U3.2 | scope: backend | tasks: T022 | files: 2 | automation: auto -->
**Unit U5.2 (Server guard regression PR)**: サーバー側の拒否経路をテストで固定。LOC 概算 ~tests。

- [x] T022 [US3] Add server-side rejection tests to `create-upload-url.fn.test.ts` + `send-reply.fn.test.ts`: フォームを開いたまま期限切れ (ウィンドウ ドリフト) → `createUploadUrlFn` と `sendReplyFn` (TX1) の双方で `outside_window` / client 検証を迂回した過大 sizeBytes・allowlist 外 contentType をサーバーが拒否 / 他テナント・他会話の s3Key 持ち込みを `sendReplyFn` が拒否し `outbound_attachment_key_rejected` を出す (FR-010)。

**Checkpoint**: 全 US が独立に機能。検証・失敗表示・再送が揃う。

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: 回帰・観測性・手動検証。複数 US に跨る仕上げ。

<!-- unit: U6.1 | deps: U3.2 | scope: test | tasks: T023-T024 | files: 2 | automation: auto -->
**Unit U6.1 (Regression + logging PR)**: echo 整合と構造化ログの回帰。LOC 概算 ~tests。

- [ ] T023 [P] Add echo-consistency regression test (`app/tests/integration/send-reply.test.ts` or `webhook-receive.test.ts`): fumireply 送信した画像行が echo の mid upsert で二重化せず・`attachments` が消えないこと (FR-012)。echo が先着し claim される経路も 1 ケース (research D7)。webhook 側 DL 失敗時にプレースホルダ化する例外 (低-3) は許容としてコメントで明示。
- [ ] T024 [P] Verify structured logs per contracts §8: `outbound_upload_url_issued` / `outbound_attachment_send_failed` (reason: `meta_error|timeout|budget_exceeded|head_validation_failed`) / `outbound_attachment_key_rejected` が既存 `event=` JSON 規約で出ること。quickstart の Logs Insights クエリで集計できる形か確認。

<!-- unit: U6.2 | deps: U3.4,U4.2,U5.1 | scope: test | tasks: T025 | files: 1 | automation: best-effort -->
**Unit U6.2 (E2E smoke PR)**: Playwright スモーク (ハーネスは現状 skip、best-effort)。LOC 概算 ~50。

- [ ] T025 [P] Add Playwright smoke to `app/tests/e2e/` per plan Testing: 実行環境に `MEDIA_BUCKET_NAME` があるとき添付ボタンが表示される / 対応外ファイル選択で client 検証エラーが出る (S3 不要)。現状 `tests/e2e/` は seed+login CI 未整備で `describe.skip` のため best-effort とし、ハーネス整備は別作業として明記。

<!-- unit: U6.3 | deps: all | scope: docs | tasks: T026-T027 | files: 0 | automation: manual -->
**Unit U6.3 (Manual verification)**: デプロイ後の手動検証。コード変更なし。

- [ ] T026 Run quickstart.md 手動検証 8 項目。**webp を最優先** (研 D5、拒否なら `ALLOWED_IMAGE_TYPES` から除外して再デプロイ) / 境界は 30MB で拒否確認 / 24h ウィンドウ外・部分失敗・ポーリング 15 分安定を確認。
- [ ] T027 Deploy 順序の確認 (quickstart §1): terraform apply (app-lambda IAM PutObject + media CORS) → app デプロイ。逆順でもアップロードが CORS/権限で失敗するだけでテキスト送信が無影響であることを確認。孤児オブジェクト (`/outbound/` 未参照) は #78 に合流。

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 依存なし、即着手可 (確認のみ)
- **Foundational (Phase 2)**: Setup 後。全 US をブロック。特に U2.1 (`media-upload.ts`) が全 server fn の前提
- **US1 (Phase 3)**: Foundational 後。MVP
- **US2 (Phase 4)**: US1 の U3.2 (parts ヘルパー) / U3.4 (ReplyForm) を土台に一般化
- **US3 (Phase 5)**: US1 の ReplyForm / send fn を土台に検証・失敗経路を足す
- **Polish (Phase 6)**: 対象 US 完了後

### User Story Dependencies

- **US1 (P1)**: Foundational のみに依存。単独で出荷可能 (画像単独送信)
- **US2 (P2)**: US1 の parts ヘルパーと ReplyForm に依存 (2 通化は US1 の拡張)
- **US3 (P2)**: US1 に依存 (US2 とは独立に検証・失敗表示を足せる)

### Within Each User Story

- テストは実装と同じ Unit 内 (`*.test.ts` 同居)。純ロジック → server fn → UI の順
- 共有ヘルパー (T009) → 配線 (T010) → UI (T013-T014)

### Parallel Opportunities

- Foundational: U2.1 / U2.2 / U2.3 は互いに独立で並列可 (別ファイル)
- US1 内: T008 (fn test) / T012 (flag) / T015 (i18n) は [P]
- US 間: US2 と US3 は US1 完了後に並列着手可 (別担当なら)
- Polish: T023 / T024 / T025 は [P]

---

## Parallel Example: Foundational (Phase 2)

```bash
# 3 つの Foundational Unit を並列で着手 (別ファイル・相互依存なし):
Task: "T002 media-upload.ts (定数 + キー + presign + Head)"
Task: "T004a messenger.ts 画像ペイロード + deadline"
Task: "T005/T006 Terraform IAM PutObject + CORS"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 Setup (確認) → Phase 2 Foundational (media-upload / messenger / terraform apply)
2. Phase 3 US1 (createUploadUrlFn → sendReplyFn 画像対応 → mediaUploadEnabled → ReplyForm)
3. **STOP and VALIDATE**: 画像単独送信を quickstart 手順 1 で独立検証
4. デプロイ/デモ (MVP)

### Incremental Delivery

1. Setup + Foundational → 土台
2. US1 → 画像単独送信 (MVP) → デプロイ
3. US2 → テキスト+画像 2 通 → デプロイ
4. US3 → 検証・失敗表示・再送 → デプロイ
5. Polish → 回帰・観測性・手動検証

---

## Notes

- [P] = 別ファイルで未完依存なし。[Story] はトレーサビリティ用
- webhook / ai-worker / DB マイグレーション / 新規 npm 依存は本機能では変更ゼロ (FR-015 非干渉)
- 本番送信ロジックは `send-reply.fn.ts` インライン、`send-reply.server.ts` はテスト用の別実装 — parts 化は両方に反映 (レビュー M-1)
- `sendError` union に新値を足さない (timeout→meta_error 写像)。DB スキーマ・ReplyForm の既存エラーマッピングを壊さない
- 各 Unit = 1 PR 目安。commit / PR は Unit 境界で区切る
- Stop フック (typecheck + lint) が各 Unit で通ること
