---
description: "Task list for Draft 操作 UX 強化 (再生成・破棄・日本語訳)"
---

# Tasks: Draft 操作 UX 強化（再生成・破棄・日本語訳）

**Input**: Design documents from `/specs/004-draft-actions-and-translation/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md
**Tests**: Included — plan.md で vitest + Playwright を明示。
**Organization**: Tasks are grouped by user story (US1 破棄 / US2 再生成 / US3 翻訳)

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Maps to spec.md user story (US1, US2, US3)

## Path Conventions

- Web app monorepo: `app/src/`, `app/tests/`, `ai-worker/src/`, `ai-worker/tests/`
- DB migrations: `app/src/server/db/migrations/`
- Terraform: `terraform/`
- i18n messages: `app/messages/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 004 で新規に必要となる設定値・依存・ローカル env を準備する。spec 003 までの環境は前提として整っている想定。

<!-- unit: U1.1 | deps: none | scope: infra | tasks: T001-T003 | files: ~3 | automation: auto -->

- [ ] T001 [P] Add DeepL API key env var loader pattern in `ai-worker/src/env.ts` (SSM path 優先、ローカルは `DEEPL_API_KEY` env 直接読み)
- [ ] T002 [P] Document DeepL Free 取得手順を README に追記（`docs/deepl-setup.md` 新規 or `README.md` セクション追加）
- [ ] T003 [P] Add `DEEPL_API_KEY_SSM_PATH` to Terraform ai-worker module input variable in `terraform/modules/ai-worker-lambda/variables.tf`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 全ユーザーストーリーの前提となる DB 拡張・スキーマ同期・lifecycle フィルタを準備する。

**⚠️ CRITICAL**: このフェーズが完了するまで US1/US2/US3 のいずれも着手不可。

<!-- unit: U2.1 | deps: U1.1 | scope: backend | tasks: T004-T007,T012 | files: ~5 | automation: auto -->

- [ ] T004 Create DB migration `app/src/server/db/migrations/0003_draft_actions_and_translation.sql`: tenants に `translation_enabled boolean NOT NULL DEFAULT false` 追加、ai_drafts に `lifecycle_status varchar(20) NOT NULL DEFAULT 'active'` / `translation_ja text` / `translation_status varchar(20)` 追加、CHECK 制約 2 本追加（data-model.md 参照）
- [ ] T005 Replace `ai_drafts.message_id` UNIQUE constraint with partial unique index `(message_id) WHERE lifecycle_status='active'` in `app/src/server/db/migrations/0003_draft_actions_and_translation.sql` (D-008)
- [ ] T006 Update Drizzle schema in `app/src/server/db/schema.ts`: tenants に `translationEnabled` 列、ai_drafts に `lifecycleStatus` / `translationJa` / `translationStatus` 列を追加、CHECK 制約定義を含める
- [ ] T007 [P] Sync ai-worker schema in `ai-worker/src/db/schema.ts` to match T006 (app と worker の schema 同期は spec 003 の約束)
<!-- unit: U2.2 | deps: U2.1 | scope: frontend | tasks: T008-T010 | files: ~4 | automation: auto -->

- [ ] T008 [P] Create `app/src/lib/drafts/lifecycle.ts` with `DRAFT_LIFECYCLE_STATUS = ['active', 'discarded', 'superseded'] as const` and Zod schema for validation
- [ ] T009 Update `app/src/routes/(app)/threads/$id/-lib/get-conversation.fn.ts`: latest_draft の SELECT に `WHERE lifecycle_status='active'` フィルタを追加、`translation_ja` と `translation_status` の取得列を追加（contracts/discard-fn.md と translation-pipeline.md 参照）
- [ ] T010 Update `app/src/routes/(app)/threads/$id/-lib/get-draft-status.fn.ts`: `lifecycle_status='active'` フィルタを追加（discarded/superseded を返さない）
<!-- unit: U2.3 | deps: U2.1 | scope: backend | tasks: T011 | files: ~1 | automation: auto -->

- [ ] T011 [P] Update ai-worker SQS message handling in `ai-worker/src/handler.ts` to support draft job 完了直後の translation hook 呼び出しポイントを準備（実装は US3 で）
- [ ] T012 Run `npm run db:migrate` locally and verify columns/constraints via the SQL queries in quickstart.md §3

**Checkpoint**: Foundation ready - US1/US2/US3 並列着手可能

---

## Phase 3: User Story 1 - 破棄ボタン (Priority: P1) 🎯 MVP

**Goal**: オーナーがスレッド詳細画面で生成されたドラフトを「破棄」ボタンでワンクリック非表示にできる。DB には履歴として残る。

**Independent Test**: ドラフト付き会話を 1 件用意 → 破棄ボタン押下 → リロード後も再表示されない、DB 上で `lifecycle_status='discarded'` を確認。

### Tests for User Story 1

> Write tests FIRST, ensure they FAIL before implementation

<!-- unit: U3.1 | deps: U2.2 | scope: frontend | tasks: T013-T014 | files: ~2 | automation: auto -->

- [ ] T013 [P] [US1] Integration test for discardDraft server fn in `app/tests/integration/discard-draft.test.ts`: active を破棄 → ok、既に discarded → already_inactive、他テナント → not_found、RLS バイパステスト
- [ ] T014 [P] [US1] Integration test for lifecycle_status filter in `app/tests/integration/conversation-status-filter.test.ts`: `getConversation` / `getDraftStatus` が discarded を返さないこと

### Implementation for User Story 1

<!-- unit: U3.2 | deps: U3.1 | scope: frontend | tasks: T015-T019 | files: ~5 | automation: auto -->

- [ ] T015 [US1] Create `app/src/routes/(app)/threads/$id/-lib/discard-draft.fn.ts` server fn per contracts/discard-fn.md (Zod input、`withTenant`、楽観ロック付き UPDATE、構造化ログ)
- [ ] T016 [US1] Create `app/src/routes/(app)/threads/$id/-components/DraftActions.tsx` with 破棄ボタン only（再生成ボタンは US2 で追加）。Optimistic UI + エラートースト
- [ ] T017 [US1] Wire `DraftActions` into draft 表示エリア in `app/src/routes/(app)/threads/$id/index.tsx` (or its existing draft 表示コンポーネント)
- [ ] T018 [P] [US1] Add i18n keys for discard button in `app/messages/en.json` and `app/messages/ja.json`: `draft_discard_button`, `draft_discard_confirm` (確認ダイアログは MVP では出さないが念のためキーは用意), `draft_discard_error`
- [ ] T019 [US1] Add structured logging for discard events in `discard-draft.fn.ts` per contracts/discard-fn.md 観測性節

**Checkpoint**: 破棄機能のみで spec 004 MVP 出荷可能

---

## Phase 4: User Story 2 - 再生成ボタン (Priority: P2)

**Goal**: オーナーが「再生成」ボタンで現 draft を `superseded` 化し、同じ会話コンテキストで新 draft を生成できる。生成中フィードバック付き。

**Independent Test**: ドラフト付き会話 → 再生成押下 → 「生成中」表示 → 新 draft 表示、DB 上で同一 message_id に旧 superseded + 新 active の 2 行が存在。

### Tests for User Story 2

<!-- unit: U4.1 | deps: U3.2 | scope: frontend | tasks: T020-T021 | files: ~2 | automation: auto -->

- [ ] T020 [P] [US2] Integration test for regenerateDraft server fn in `app/tests/integration/regenerate-draft.test.ts`: active → ok（旧 superseded、新行 INSERT、SQS enqueue）、既に superseded → already_inactive、partial unique index 違反テスト、SQS mock fail → enqueue_failed + ロールバック
- [ ] T021 [P] [US2] Update `app/tests/integration/conversation-status-filter.test.ts` to also verify superseded drafts は UI 取得経路から除外されること

### Implementation for User Story 2

<!-- unit: U4.2 | deps: U4.1 | scope: frontend | tasks: T022-T026 | files: ~5 | automation: auto -->

- [ ] T022 [US2] Extract draft enqueue logic into `app/src/server/services/enqueue-draft-job.ts` (既存の draft enqueue ロジックを helper 化、新 draft 行 INSERT + SQS send を担当)
- [ ] T023 [US2] Create `app/src/routes/(app)/threads/$id/-lib/regenerate-draft.fn.ts` server fn per contracts/regenerate-fn.md (トランザクション内で旧 superseded + 新 INSERT、その後 SQS enqueue)
- [ ] T024 [US2] Extend `DraftActions.tsx` (US1 で作成済) to add 再生成ボタン + 「生成中」状態 + 両ボタン disable ロジック。新 draft の status='ready' 到達は既存 `getDraftStatus` ポーリングを再利用
- [ ] T025 [P] [US2] Add i18n keys in `app/messages/en.json` and `app/messages/ja.json`: `draft_regenerate_button`, `draft_regenerate_loading`, `draft_regenerate_error`
- [ ] T026 [US2] Add structured logging for regenerate events per contracts/regenerate-fn.md 観測性節

**Checkpoint**: 破棄 + 再生成が独立に動作する

---

## Phase 5: User Story 3 - 日本語訳 (Priority: P3)

**Goal**: Settings でトグルを ON にすると、新規 draft 生成時に DeepL Free で和訳を取得し、スレッド詳細に並記表示。OFF なら呼ばない。失敗時は本体に影響なし。

**Independent Test**: Settings ON → 新着メッセージ → ドラフトに英語＋日本語訳が並んで表示。Settings OFF → 既存翻訳は UI 非表示、新規 draft の `translation_ja` は NULL。

### Tests for User Story 3

<!-- unit: U5.1 | deps: U2.3 | scope: backend | tasks: T027-T028,T030-T032 | files: ~3 | automation: auto -->

- [ ] T027 [P] [US3] Unit test for `callDeepL` in `ai-worker/tests/translation.test.ts`: 200 → ok、456 → failed + quota_exceeded ログ、AbortError → failed + timeout ログ、403 → failed + auth ログ
- [ ] T028 [P] [US3] Unit test for `translateDraftIfEnabled` in `ai-worker/tests/translation.test.ts`: translation_enabled=true + draft 'ready' → DeepL 呼ぶ、translation_enabled=false → skipped、draft 'failed' → skipped
<!-- unit: U5.3 | deps: U2.2 | scope: frontend | tasks: T029,T034-T040 | files: ~8 | automation: auto -->

- [ ] T029 [P] [US3] Integration test for updateTranslationToggle in `app/tests/integration/translation-toggle.test.ts`: false→true / true→false の遷移、RLS 隔離

### Implementation for User Story 3

- [ ] T030 [P] [US3] Create `ai-worker/src/translation.ts` with `callDeepL(text)`, `classifyDeepLError(err)`, `translateDraftIfEnabled(...)` per contracts/translation-pipeline.md
- [ ] T031 [US3] Wire `translateDraftIfEnabled` into `ai-worker/src/handler.ts` after draft body 保存ステップ。draft.status / translation_enabled の読み取りも実装
- [ ] T032 [US3] Add DeepL API key SSM fetch in `ai-worker/src/env.ts` using existing `getSsmParameter()` pattern (spec 003 流儀)、Lambda モジュールスコープでキャッシュ
<!-- unit: U5.2 | deps: U2.1 | scope: infra | tasks: T033 | files: ~2 | automation: auto -->

- [ ] T033 [US3] Update Terraform: SSM Parameter `/fumireply/review/deepl_api_key` 作成 + ai-worker IAM ロールに `ssm:GetParameter` 追加 ARN in `terraform/envs/review/main.tf`
- [ ] T034 [P] [US3] Create `app/src/routes/(app)/settings/-lib/update-translation-toggle.fn.ts` per contracts/settings-toggle.md §B
- [ ] T035 [US3] Update `app/src/routes/(app)/settings/-lib/list-settings.fn.ts` to also return `translationEnabled` (contracts/settings-toggle.md §A)
- [ ] T036 [US3] Create `app/src/routes/(app)/settings/-components/TranslationToggle.tsx` with AutoSaveBadge 連携 (contracts/settings-toggle.md §C)
- [ ] T037 [US3] Wire `TranslationToggle` into `app/src/routes/(app)/settings/index.tsx` (新セクション追加)
- [ ] T038 [P] [US3] Create `app/src/routes/(app)/threads/$id/-components/DraftTranslation.tsx`: `translation_ja` があれば表示、`translation_status='failed'` なら失敗バッジ、`translation_enabled=false`（設定 OFF）なら何も出さない
- [ ] T039 [US3] Wire `DraftTranslation` into draft 表示エリア（DraftActions の近く、本文の下）
- [ ] T040 [P] [US3] Add i18n keys in `app/messages/en.json` and `app/messages/ja.json` per contracts/settings-toggle.md §C: `settings_translation_label`, `settings_translation_description`, `settings_translation_quota_warning`, `draft_translation_label`, `draft_translation_failed_badge`

**Checkpoint**: 3 機能が全て独立に動作

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: i18n コンパイル・E2E スモーク・ドキュメント・スキーマ後方互換確認

<!-- unit: U6.1 | deps: U3.2,U4.2,U5.3 | scope: infra | tasks: T041,T043 | files: 0 | automation: auto -->

- [ ] T041 Run `npm run paraglide:compile` and verify no missing keys
<!-- unit: U6.2 | deps: U3.2,U4.2,U5.3 | scope: frontend | tasks: T042 | files: ~1 | automation: auto -->

- [ ] T042 [P] Create E2E spec `app/tests/e2e/draft-actions.spec.ts` covering 3 scenarios per quickstart.md §4 (破棄 / 再生成 / 翻訳 ON フロー)
- [ ] T043 Run `npm run typecheck` and `npm run lint` across `app/` and `ai-worker/`, fix any drift
<!-- unit: U6.3 | deps: U3.2,U4.2,U5.3 | scope: docs | tasks: T044-T045 | files: ~2 | automation: auto -->

- [ ] T044 [P] Update `docs/` (or top-level README) with spec 004 のリリースノート: 3 機能の概要 + Settings 翻訳トグルの位置 + DeepL Free 上限の注意書き
- [ ] T045 Verify SC-005 (履歴クエリ集計): write a sample SQL query `SELECT tenant_id, COUNT(*) FILTER (WHERE lifecycle_status='discarded') AS discarded_count, COUNT(*) FILTER (WHERE lifecycle_status='superseded') AS regen_count FROM ai_drafts WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY tenant_id` and confirm it runs without index on lifecycle_status
<!-- unit: U6.4 | deps: U6.1,U6.2,U6.3 | scope: infra | tasks: T046 | files: 0 | automation: manual -->

- [ ] T046 Run quickstart.md §4a-4e 動作確認手順をローカルで手動実行し、5 シナリオ全て pass

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 依存なし、即時着手可能
- **Foundational (Phase 2)**: Setup 完了後、US1/US2/US3 全てを block
- **User Stories (Phase 3+)**: Foundational 完了後にすべて並列着手可能
- **Polish (Phase 6)**: 全 US 完了後

### User Story Dependencies

- **US1 破棄 (P1)**: Foundational のみ依存。US2/US3 と独立
- **US2 再生成 (P2)**: Foundational + US1（DraftActions コンポーネントを拡張するため）。US3 と独立
- **US3 翻訳 (P3)**: Foundational のみ依存。US1/US2 と独立（DraftTranslation は別コンポーネント）

> 注: US2 の T024 は US1 の T016 で作成した `DraftActions.tsx` を拡張する。並列実装する場合は、US1 の T016 を先にマージするか、US2 担当が新規ファイル `DraftActionsRegenerate.tsx` を作って index.tsx で両方マウントする逃げ道もある。

### Within Each User Story

- Tests (T013/T014, T020/T021, T027-T029) を先に書いて FAIL を確認
- Models / schema → server fn → UI コンポーネント → ログ追加 の順

### Parallel Opportunities

- Phase 1 の T001/T002/T003 は全て独立
- Phase 2 では T007, T008 が他と並列可（schema 同期と定数追加は独立）
- US1 / US2 / US3 は Foundational 完了後に 3 つを並列担当可能
- 各 US 内のテスト task ([P]) も並列可能
- i18n キー追加 (T018, T025, T040) は他の実装と並列可能

---

## Parallel Example: User Story 3

```bash
# 翻訳パイプラインのテストとサーバ側実装を並列で:
Task: "Unit test callDeepL in ai-worker/tests/translation.test.ts"        # T027
Task: "Unit test translateDraftIfEnabled in ai-worker/tests/translation.test.ts"  # T028
Task: "Integration test updateTranslationToggle in app/tests/integration/translation-toggle.test.ts"  # T029

# UI 系コンポーネントも並列で:
Task: "Create TranslationToggle.tsx in app/src/routes/(app)/settings/-components/"  # T036
Task: "Create DraftTranslation.tsx in app/src/routes/(app)/threads/$id/-components/"  # T038
Task: "Add i18n keys in app/messages/{en,ja}.json"  # T040
```

---

## Implementation Strategy

### MVP First (US1 のみ)

1. Phase 1 Setup（T001 のみ必須、T002/T003 は US3 でなければ skip 可）
2. Phase 2 Foundational 全て（T012 の DB マイグレーション確認まで）
3. Phase 3 US1 完了
4. **STOP and VALIDATE**: 破棄機能を本番 review env で動作確認
5. リリース判断: 単独でも価値あり（spec の US1 priority P1 根拠）

### Incremental Delivery

1. Setup + Foundational → 基盤完成
2. US1 → 破棄 MVP リリース
3. US2 → 再生成リリース（同 PR or 別 PR）
4. US3 → 翻訳リリース
5. Polish (e2e + docs) → 仕上げ

### Parallel Team Strategy

- 1 人運用なら順次（US1 → US2 → US3）が安全
- 2 人なら Foundational 完了後に US1 担当 + US3 担当（DraftActions の競合がない）が効率的
- US2 は US1 マージ後に始めるか、新ファイルで進めて後でマージ

---

## Notes

- [P] tasks = different files, no dependencies
- 既存ファイルへの修正タスク（T009, T010, T017, T024, T031, T035, T037, T039）は [P] にしない（同一ファイル衝突回避）
- 各 US 完了時にコミット推奨。Foundational 完了時は単独 PR 化が望ましい（巨大化防止）
- 翻訳機能（US3）の Terraform 変更（T033）は本番反映前にレビュー必須
- DeepL API キーは GitHub secrets / SSM に置き、コミット禁止
