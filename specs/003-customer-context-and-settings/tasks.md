---
description: "Tasks for 003 — 会話コンテキストの永続化と設定の階層化 (Settings + CustomerPanel + 要約パイプライン)"
---

# Tasks: 会話コンテキストの永続化と設定の階層化

**Input**: Design documents from `/specs/003-customer-context-and-settings/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: 含む。`buildAdditionalSystemPrompt` / `buildSummaryPrompt` / `computeAccumulatedCharLength` の純粋関数 unit、server fn の RLS + バリデーション integration、要約パイプラインの冪等性、SC-007 (全 NULL での回帰なし) を担保するため。E2E は Settings 保存 → CustomerPanel 編集 → AI ドラフト反映の 1 シナリオを Phase N で実施。

**Organization**: User Story 単位でフェーズ分割。US1 / US2 / US3 はそれぞれ独立にテスト可能。Phase 2 (Foundational) で「draft プロンプト合成関数 + 修正済み processDraftJob」を完成させることで、各 Story の UI 側変更を投入するだけで AI ドラフトに反映される構造にする。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並列実行可（異なるファイルで未完依存なし）
- **[Story]**: US1 / US2 / US3（Setup / Foundational / Polish フェーズには付けない）
- 各タスクに具体ファイルパスを含む
- チェックボックス: `[x]` 完了 / `[ ]` 未着手

## Path Conventions

- TanStack Start アプリ本体: `app/src/`、`app/tests/`、`app/messages/`
- AI Worker Lambda: `ai-worker/src/`、`ai-worker/tests/`
- Webhook Lambda: `webhook/src/`
- DB マイグレーション: `app/src/server/db/migrations/`
- Terraform: `terraform/envs/review/`、`terraform/modules/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: ブランチ確認、依存追加なし確認、共通定数モジュールの新設。コード規模が小さい。

<!-- unit: U1.1 | deps: none | scope: backend | tasks: T001-T017 | files: ~10 | automation: auto -->
**Unit U1.1 (Foundation PR)**: Phase 1 + Phase 2 を 1 PR にまとめる。DB マイグレーション + ai-worker プロンプト合成リファクタ + UI 共通部品 (AutoSaveBadge / i18n キー雛形 / 3 カラム CSS) + 回帰テスト (handler 全 NULL ガード)。これが全 Story の前提なので最初にマージされる。LOC 概算 ~500。

- [x] T001 Verify branch is `003-customer-context-and-settings` (created by /speckit.specify) and run `npm ci` in both `app/` and `ai-worker/` to ensure clean install (no new dependencies expected — both already have `@anthropic-ai/sdk` / `@aws-sdk/client-sqs` / `drizzle-orm` / `zod`)

- [x] T002 [P] Create `app/src/lib/settings/char-limits.ts` exporting `PAGE_PROMPT_MAX = 2000`, `CUSTOMER_PROMPT_MAX = 1000`, `NOTE_MAX = 1000`, and `SUMMARY_TRIGGER_THRESHOLD_CHARS = 2000` (env override via `process.env.SUMMARY_TRIGGER_THRESHOLD_CHARS`), plus Zod schemas `pagePromptSchema`, `customerPromptSchema`, `noteSchema` for reuse across server fns (per research.md R-003)

- [x] T003 [P] Mirror the same constants in `ai-worker/src/config.ts` (new file) — `SUMMARY_TRIGGER_THRESHOLD_CHARS`, `RECENT_MESSAGES_CAP = 50`, `SUMMARY_MAX_INPUT_MESSAGES = 200`. ai-worker is a separate Lambda package so it cannot import from `app/`; constants must be duplicated. Add a comment referencing `app/src/lib/settings/char-limits.ts` for drift awareness

- [x] T004 [P] Add new env vars to `app/.env.example` (and `ai-worker/.env.example` if present): `AI_SUMMARY_QUEUE_URL=`, `SUMMARY_TRIGGER_THRESHOLD_CHARS=2000`, `SUMMARY_PIPELINE_ENABLED=true`. Document each per `contracts/summary-job.md` §env

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: DB スキーマ追加 + AI Worker のプロンプト合成基盤 + 共通 UI 部品の整備。**この段階完了までは US1 / US2 / US3 の本格実装に入れない**。

**⚠️ CRITICAL**: T005〜T015 のいずれかが未完だと各 Story の server fn / コンポーネントを実装してもコンパイル/起動しない可能性が高い。

### DB スキーマ

- [x] T005 Update Drizzle schema in `app/src/server/db/schema.ts` — add `customPrompt` (text, nullable) to `connectedPages`, add `summary, lastSummarizedAt, tonePreset, customPrompt, note` to `conversations`. Add `check()` constraints per data-model.md "Drizzle Schema 差分" section (3 CHECK constraints on conversations, 1 on connected_pages)
- [x] T006 [P] Mirror the same schema additions in `ai-worker/src/db/schema.ts` (keep app and ai-worker schemas in sync — both packages compile against this shape)
- [x] T007 Run `npm run db:generate` in `app/` to produce `app/src/server/db/migrations/0002_customer_context.sql`. Verify the generated SQL matches data-model.md "マイグレーション" section (6 ADD COLUMN + 4 ADD CONSTRAINT). Hand-edit if Drizzle omits the CHECK constraint syntax
- [x] T008 Apply migration locally via `npm run db:migrate` in `app/`. Verify via psql/Supabase Studio that all 6 columns exist and CHECK constraints reject invalid `tone_preset` and over-length `custom_prompt` (per quickstart.md §2 confirmation queries)

### AI Worker — プロンプト合成基盤 (US 共通)

- [x] T009 Refactor `ai-worker/src/prompt.ts` — extract `BASE_SYSTEM_PROMPT` (existing hard-coded prompt) as a named export, add new exported pure function `buildAdditionalSystemPrompt(parts: { pagePrompt: string | null; tonePreset: 'friendly'|'professional'|'concise'|null; customerPrompt: string | null; summary: string | null }): string` that composes sections in the order Page → Tone → Customer → Summary per `contracts/prompt-composition.md`. Also export `TONE_LABEL` constant. Per research.md R-008, the function signature MUST NOT accept `note`
- [x] T010 Modify `buildUserPrompt` in `ai-worker/src/prompt.ts` to take the same `HistoryMessage[]` shape but document that callers will pass up to `RECENT_MESSAGES_CAP = 50` items (no internal change to the function, but update JSDoc to reflect that cursor-based filtering now happens at the caller in handler.ts)
- [x] T011 [P] Modify `ai-worker/src/handler.ts` `processRecord` to:
   1. Parse SQS body and dispatch on `jobType` (default `'draft'` for back-compat per contracts/summary-job.md §dispatch)
   2. Extract the existing draft-handling logic into a new function `processDraftJob(body)`
   3. Inside `processDraftJob`, after resolving tenant, SELECT new columns (`conversations.summary, last_summarized_at, tone_preset, custom_prompt` and `connected_pages.custom_prompt` via `conversations.page_id`) in the same `withTenant` transaction
   4. Replace the `LIMIT 5` history query with a cursor-aware query: `WHERE timestamp > COALESCE(last_summarized_at, '1970-01-01'::timestamptz) ORDER BY timestamp DESC LIMIT 50`
   5. Build `system` field as a 2-element array — `[{ text: BASE_SYSTEM_PROMPT, cache_control: ephemeral }, { text: buildAdditionalSystemPrompt(...) }]` and OMIT the second element if it returns empty string
   6. Add structured log event `draft_prompt_composed` per contracts/prompt-composition.md §ログ
- [x] T012 Add wrapper for `processSummaryJob(body)` stub in `ai-worker/src/handler.ts` — initially a no-op that logs `event: 'summary_skipped_not_yet_implemented'`. Story 3 fills it in. This makes `jobType: 'summary'` consumable from day 1 without DLQ flooding

### AI Worker — Tests (foundational backward compat)

- [x] T013 [P] Add unit tests in `ai-worker/src/prompt.test.ts` (new file) for `buildAdditionalSystemPrompt`:
   - All 4 args null → returns empty string
   - Each arg present individually → output contains the corresponding section label and value
   - All present → sections appear in order Page → Tone → Customer → Summary
   - `note` cannot be passed (TypeScript should reject; runtime test confirms that even if a "note"-like field were spread into parts, it doesn't appear in output)
   - tonePreset enum → TONE_LABEL value present
- [x] T014 Update existing tests in `ai-worker/src/handler.test.ts` — add cases for:
   - All new columns NULL (back-compat, SC-007): Anthropic is called with only the base system prompt, and history of up to 50 (not 5) text messages
   - jobType `'summary'` (no-op stub from T012): handler returns without throwing
   - Existing draft tests (current cases) continue to pass (regression guard)

### UI — 共通部品 + i18n キー雛形

- [x] T015 [P] Implement shared `AutoSaveBadge` component in `app/src/routes/(app)/-components/AutoSaveBadge.tsx` — props `state: 'editing' | 'saving' | 'saved' | null`, renders i18n-aware text with subtle color. Reused by both Settings and CustomerPanel
- [x] T016 [P] Add i18n key skeleton entries to `app/messages/en.json` and `app/messages/ja.json` for Settings + CustomerPanel — list of keys (with placeholder values to be filled per-story):
   - Settings: `settings_title, settings_subtitle, settings_section_pages, settings_no_pages_empty, settings_no_pages_cta, settings_page_prompt_label, settings_page_prompt_placeholder, settings_page_prompt_help, settings_chars_remaining`
   - CustomerPanel: `cp_section_persona, cp_persona_disclaimer, cp_persona_empty, cp_section_ai_settings, cp_tone_label, cp_tone_friendly, cp_tone_professional, cp_tone_concise, cp_custom_prompt_label, cp_custom_prompt_placeholder, cp_section_note, cp_note_label, cp_note_placeholder, cp_toggle_show, cp_toggle_hide`
   - Save state shared: `autosave_editing, autosave_saving, autosave_saved`
- [x] T017 [P] Add CSS for the future 3-column layout in `app/styles.css` (or wherever thread page styles live) — define `.customer-panel` width/position, a `--customer-panel-width: 320px` token, and a media query for `width < 1280px` that defaults to hidden + toggle button visible (per research.md R-009)

**Checkpoint**: DB に新規 6 列が入り、ai-worker は全列 NULL でも回帰なく動作し、ai-worker のプロンプト合成は 5 段化されている (実際の値はまだ NULL なのでベース挙動のまま)。UI 共通部品と i18n キー雛形が準備済。

---

## Phase 3: User Story 1 — ページ単位の店舗ポリシー + Settings 画面 (Priority: P1) 🎯 MVP

**Goal**: Settings 画面でページごとの「店舗ポリシー (カスタムプロンプト)」を 1 枠の textarea で設定でき、その内容が AI ドラフト生成プロンプトに反映される。

**Independent Test**: spec.md §Story 1 Independent Test に従い、カスタムプロンプトに特定文字列を含む指示を保存し、新着 inbound 後の AI ドラフトにその指示が反映されることをブラウザ + DB + ai_drafts テーブルで確認できる。

<!-- unit: U2.1 | deps: U1.1 | scope: frontend | tasks: T018-T027 | files: ~7 | automation: auto -->
**Unit U2.1 (Settings PR)**: US1 を 1 PR にまとめる。listSettings/updatePagePrompt 2 server fn + `/settings` route + 4 コンポーネント (ConnectedPagesList / PageCustomPromptEditor / EmptyState) + サイドバーリンク差替 + Settings 翻訳 + E2E。U1.1 マージ後に着手。LOC 概算 ~250。

### Server fns (US1)

- [ ] T018 [P] [US1] Implement `listSettingsFn` server fn in `app/src/routes/(app)/settings/-lib/list-settings.fn.ts` — returns `{ connectedPages: Array<{ id, pageId, pageName, isActive, connectedAt, customPrompt }> }` sorted by `connectedAt DESC` for current tenant (per contracts/settings-fns.md §list-settings.fn.ts). Wrap in `withTenant`, log `list_settings_ok` / `list_settings_failed`
- [ ] T019 [P] [US1] Implement `updatePagePromptFn` server fn in `app/src/routes/(app)/settings/-lib/update-page-prompt.fn.ts` — input `{ pageId, customPrompt }`, Zod validates max 2000 chars (use `pagePromptSchema` from T002), normalizes empty string → NULL, UPDATE inside `withTenant`, 404 on affected row count = 0. Per contracts/settings-fns.md §update-page-prompt.fn.ts. Log `update_page_prompt_ok` / `update_page_prompt_failed`
- [ ] T020 [US1] Add integration tests in `app/tests/integration/settings-fns.test.ts` (new file) — happy path, 2001-char rejection (`PAGE_PROMPT_TOO_LONG`), cross-tenant write (RLS → 404 `PAGE_NOT_FOUND`), empty string normalization to NULL

### Settings route + components (US1)

- [ ] T021 [US1] Create route file `app/src/routes/(app)/settings/index.tsx` — `createFileRoute('/(app)/settings/')`, loader calls `listSettingsFn`, renders page header + section + `ConnectedPagesList`. i18n via `m.settings_title()` etc.
- [ ] T022 [P] [US1] Implement `ConnectedPagesList` component in `app/src/routes/(app)/settings/-components/ConnectedPagesList.tsx` — receives `connectedPages` array, renders one `PageCustomPromptEditor` per page; if 0 pages, renders `EmptyState`
- [ ] T023 [P] [US1] Implement `PageCustomPromptEditor` component in `app/src/routes/(app)/settings/-components/PageCustomPromptEditor.tsx` — props `{ pageId, pageName, customPrompt }`. textarea with debounce 500ms autosave calling `updatePagePromptFn`, AutoSaveBadge (T015), remaining-char counter using `PAGE_PROMPT_MAX - value.length`, soft block at limit (textarea rejects further input via maxLength)
- [ ] T024 [P] [US1] Implement `EmptyState` component in `app/src/routes/(app)/settings/-components/EmptyState.tsx` — message + CTA linking to `/onboarding/connect-page` (route established in 002)
- [ ] T025 [US1] Modify `app/src/routes/(app)/route.tsx` — change the sidebar Settings entry on line 43 from `href: '#'` to `href: '/settings'` (and wrap with `<Link>` if not already). Verify other sidebar items unchanged
- [ ] T026 [US1] Fill the Settings-related i18n keys (T016 skeleton) in `app/messages/en.json` and `app/messages/ja.json` with real translations. Run `npx paraglide-js compile` in `app/`

### E2E (US1, partial)

- [ ] T027 [US1] Add Playwright test snippet in `app/tests/e2e/customer-context.spec.ts` (new file, will be extended in US2/US3) — login → click sidebar Settings → /settings loads → see at least one PageCustomPromptEditor → type text → wait for AutoSaveBadge "saved" → reload → text persists

**Checkpoint**: Settings 画面が動作し、ページカスタムプロンプトが永続化される。AI ドラフト生成時には ai-worker (Foundational T011 で既に対応済) がページの custom_prompt を読んでプロンプトに含める。Story 1 はこの時点で出荷可能。

---

## Phase 4: User Story 2 — 顧客 (会話) 単位の AI ドラフト設定 + CustomerPanel (Priority: P1)

**Goal**: スレッド画面の右カラム CustomerPanel で、その会話相手専用の AI 動作 (トーン + カスタム指示 + 内部メモ) を設定でき、AI ドラフト生成プロンプトに反映される。

**Independent Test**: spec.md §Story 2 Independent Test に従い、任意のスレッドで CustomerPanel からトーン「簡潔」+ カスタム指示「絵文字なし」を保存後、新着メッセージへの AI ドラフトが簡潔で絵文字なしの文体になることを確認できる。

<!-- unit: U3.1 | deps: U1.1 | scope: frontend | tasks: T028-T039 | files: ~9 | automation: auto -->
**Unit U3.1 (CustomerPanel PR)**: US2 を 1 PR にまとめる。getConversation 拡張 + updateConversationSettings server fn + 5 コンポーネント (CustomerPanel / Header / AiPersonaSummary placeholder / DraftSettingsEditor / InternalNoteEditor) + threads 3 カラム化 + CustomerPanel 翻訳 + E2E。U1.1 マージ後、U2.1 と並列で着手可能 (両者は touch するファイル群が完全に分離)。LOC 概算 ~350。

### Server fns (US2)

- [ ] T028 [US2] Modify `app/src/routes/(app)/threads/$id/-lib/get-conversation.fn.ts` — extend the conversation SELECT to include `summary, last_summarized_at, tone_preset, custom_prompt, note`. Return all 5 fields in the conversation object per contracts/conversation-fns.md
- [ ] T029 [P] [US2] Implement `updateConversationSettingsFn` server fn in `app/src/routes/(app)/threads/$id/-lib/update-conversation-settings.fn.ts` — Zod validates: optional `tonePreset` (enum or null), optional `customPrompt` (max 1000), optional `note` (max 1000), refine at least one field present. Dynamic SET clause UPDATE inside `withTenant`. Per contracts/conversation-fns.md §update-conversation-settings.fn.ts. Log `update_conversation_settings_ok` / `update_conversation_settings_failed`
- [ ] T030 [US2] Add integration tests in `app/tests/integration/conversation-fns.test.ts` (new file) — partial update (tonePreset only) doesn't touch other cols, empty string → NULL normalization for customPrompt and note, max-length rejection, `NO_FIELDS_PROVIDED` error, cross-tenant → 404
- [ ] T031 [US2] Add unit test in `app/tests/integration/ai-draft-uses-conversation-settings.test.ts` (new file) — set `tone_preset='concise'` and `custom_prompt='No emojis.'` on a test conversation, enqueue a draft job, verify the ai-worker sends an Anthropic system payload that includes both segments. This validates that Foundational T011 wiring correctly reads the new columns. Mock Anthropic SDK via `vi.mock`

### CustomerPanel components (US2)

- [ ] T032 [P] [US2] Implement `CustomerPanel` container component in `app/src/routes/(app)/threads/$id/-components/CustomerPanel.tsx` — props `{ conversation, onUpdate }`. Layout: Header → AiPersonaSummary (US3 will fill, US2 renders empty placeholder) → DraftSettingsEditor → InternalNoteEditor. Manages local state for show/hide on narrow viewports + localStorage persistence (per R-009)
- [ ] T033 [P] [US2] Implement `CustomerPanelHeader` in `app/src/routes/(app)/threads/$id/-components/CustomerPanelHeader.tsx` — avatar (reuse existing `Avatar` from ui/) + customer_name (or psid fallback) + PSID line. No stats/tags (out of scope per FR-OOS-003)
- [ ] T034 [P] [US2] Implement `AiPersonaSummary` placeholder in `app/src/routes/(app)/threads/$id/-components/AiPersonaSummary.tsx` — for US2, renders only `m.cp_persona_empty()` placeholder (no summary fetch). US3 will extend
- [ ] T035 [P] [US2] Implement `DraftSettingsEditor` in `app/src/routes/(app)/threads/$id/-components/DraftSettingsEditor.tsx` — three radio-style buttons for tone_preset (friendly/professional/concise) with `null` reset option, textarea for custom_prompt (max 1000, char counter, debounce 500ms autosave), AutoSaveBadge
- [ ] T036 [P] [US2] Implement `InternalNoteEditor` in `app/src/routes/(app)/threads/$id/-components/InternalNoteEditor.tsx` — textarea for note (max 1000, char counter, debounce 500ms autosave), AutoSaveBadge. Visual hint that this is an internal note not sent to AI (per FR-016)
- [ ] T037 [US2] Modify `app/src/routes/(app)/threads/$id/index.tsx` — extend layout from 2-column to 3-column by adding `<CustomerPanel conversation={conversation} ... />` after the thread view div. Add a toggle button in the thread header (visible on narrow viewports) that flips show/hide state in `CustomerPanel`. Pass conversation object including new columns from loader

### i18n + E2E (US2)

- [ ] T038 [US2] Fill CustomerPanel-related i18n keys (T016 skeleton) in `app/messages/en.json` and `app/messages/ja.json` with real translations. Run `npx paraglide-js compile` in `app/`
- [ ] T039 [US2] Extend `app/tests/e2e/customer-context.spec.ts` — open a thread → assert CustomerPanel visible → click tone "Concise" → AutoSaveBadge becomes "saved" → reload → tone selection persists. Note: this test does NOT need a real AI draft (covered separately in T031/T046)

**Checkpoint**: スレッド画面右カラム CustomerPanel が動作し、トーン・カスタム指示・内部メモが永続化される。AI ドラフト生成時に Foundational の prompt composition が顧客設定を読んでプロンプトに含める (内部メモは含まれない)。Story 2 はこの時点で出荷可能。

---

## Phase 5: User Story 3 — 会話要約パイプライン + AI 認識像表示 (Priority: P2)

**Goal**: 会話の累計文字数 (カーソル以降 inbound + outbound) が 2,000 文字を超えると要約 Lambda が自動発火し、`conversations.summary` を更新する。要約は AI ドラフトプロンプトに含まれ、CustomerPanel に「AI が認識している顧客像」として表示される。

**Independent Test**: spec.md §Story 3 Independent Test に従い、特定の会話に 2,000 文字超のメッセージ群を作り、要約パイプライン発火 → DB の `summary` 更新 → AI ドラフトのトークン使用量が要約なしより 60% 削減 → CustomerPanel に AI 要約表示、を確認できる。

<!-- unit: U4.1 | deps: U1.1,U3.1 | scope: backend | tasks: T040-T055,T058-T060 | files: ~13 | automation: auto -->
**Unit U4.1 (Summary Pipeline PR)**: US3 + Polish (auto 分) を 1 PR にまとめる。Terraform SQS + IAM/env + maybeEnqueueSummaryJob 共通ヘルパ + webhook/app 両経路への組込 + buildSummaryPrompt + processSummaryJob 実装 + AiPersonaSummary 本実装 + E2E + lint/typecheck/test 一括 + docs 更新。U3.1 (AiPersonaSummary placeholder) マージ後に着手。LOC 概算 ~450。これが最後の auto PR。

### Infrastructure (US3) — Terraform

- [ ] T040 [P] [US3] Add new SQS queue in `terraform/envs/review/main.tf` using `terraform/modules/queue` — name `ai-summary-queue`, visibility_timeout 60, max_receive_count 3, DLQ `ai-summary-dlq`. Per contracts/summary-job.md §Terraform 差分
- [ ] T041 [US3] Update `terraform/modules/ai-worker-lambda/variables.tf` to accept an optional second event source queue ARN (e.g., `summary_queue_arn`), then in `main.tf` add a second `aws_lambda_event_source_mapping` block conditional on that variable. Update `terraform/modules/ai-worker-lambda/main.tf` IAM policy to grant `sqs:ReceiveMessage / DeleteMessage / GetQueueAttributes` on the new queue ARN
- [ ] T042 [US3] Update `terraform/envs/review/main.tf` to: (a) pass the summary queue ARN to ai_worker_lambda module, (b) grant app_lambda IAM `sqs:SendMessage` on the new queue, (c) inject env vars `AI_SUMMARY_QUEUE_URL`, `SUMMARY_TRIGGER_THRESHOLD_CHARS`, `SUMMARY_PIPELINE_ENABLED` into both ai_worker_lambda and app_lambda

### Summary trigger (US3) — webhook + app

- [ ] T043 [P] [US3] Implement `maybeEnqueueSummaryJob(conversationId, tx)` helper in `app/src/server/services/summary-trigger.ts` (new file) — within the caller's `withTenant` transaction, compute `SUM(char_length(body))` for messages where `conversation_id = ? AND message_type = 'text' AND timestamp > COALESCE(last_summarized_at, '1970-01-01'::timestamptz)`. If >= threshold (`SUMMARY_TRIGGER_THRESHOLD_CHARS`), enqueue an SQS message `{ jobType: 'summary', conversationId, enqueuedAt }` to `AI_SUMMARY_QUEUE_URL`. The SQS send itself runs AFTER the calling transaction commits (per research.md R-005) — return a "post-commit hook" or have the helper accept a `tx` plus return a deferred async function the caller must await after commit. Log `summary_enqueue_skipped_below_threshold` / `summary_enqueued`. Fail-open: if `AI_SUMMARY_QUEUE_URL` empty or SUMMARY_PIPELINE_ENABLED=false, log warning and skip. SQS send failures are non-fatal (log warning, return)
- [ ] T044 [P] [US3] Wire `maybeEnqueueSummaryJob` into the webhook Lambda inbound INSERT path in `webhook/src/handler.ts` (or its equivalent). Call after the existing AI draft job enqueue, after the `withTenant` block commits. Pass the inserted message's `conversation_id`
- [ ] T045 [US3] Wire `maybeEnqueueSummaryJob` into the outbound INSERT path in `app/src/server/fns/send-reply.fn.ts` (or wherever messages are inserted on operator send). Call after successful INSERT, after the transaction commits

### Summary processor (US3) — ai-worker

- [ ] T046 [US3] Implement `buildSummaryPrompt(existingSummary, messages)` pure function in `ai-worker/src/prompt.ts` — per contracts/summary-job.md §buildSummaryPrompt. Returns `{ system, user }`. System prompt fixed in English, user prompt formats existing summary + new messages, or messages alone if no prior summary
- [ ] T047 [US3] Implement `processSummaryJob(body)` in `ai-worker/src/summary.ts` (new file) — replace the stub from T012. Steps per contracts/summary-job.md §processSummaryJob: parse body with Zod, resolve tenant via `dbAdmin`, re-evaluate threshold inside `withTenant` (R-006 idempotency), call Anthropic Haiku 4.5 with `buildSummaryPrompt`, UPDATE `conversations.summary` + `conversations.last_summarized_at` (= last message timestamp included). Reuse the existing `callAnthropicWithRetry` style from `handler.ts`. Honor `SUMMARY_PIPELINE_ENABLED=false` by returning early with `event: 'summary_pipeline_disabled'`
- [ ] T048 [US3] Update `ai-worker/src/handler.ts` — replace the `processSummaryJob` no-op stub (T012) with the real import from `./summary`. Add structured logs `summary_started`, `summary_completed`, `summary_skipped_below_threshold`, `summary_failed` per contracts/summary-job.md
- [ ] T049 [US3] Add tests in `ai-worker/src/summary.test.ts` (new file) for:
   - `buildSummaryPrompt` unit (with/without existing summary)
   - `processSummaryJob` idempotency: enqueue twice in row with no new messages → second call hits `summary_skipped_below_threshold`
   - Failure path: Anthropic mock throws → `last_summarized_at` is NOT updated → next enqueue re-tries
   - SUMMARY_PIPELINE_ENABLED=false → returns early
   Mock Anthropic SDK via `vi.mock`

### AI 認識像 UI (US3)

- [ ] T050 [US3] Extend `app/src/routes/(app)/threads/$id/-components/AiPersonaSummary.tsx` (placeholder from T034) — render summary text + disclaimer (`m.cp_persona_disclaimer()`) + last-updated timestamp (`m.cp_persona_updated_at({ at: lastSummarizedAt })`). If summary is null, render `m.cp_persona_empty()` placeholder. Reads from conversation object passed by CustomerPanel (already includes summary + last_summarized_at after T028)
- [ ] T051 [US3] Verify `getConversation.fn.ts` (T028) returns the latest summary on each loader call (already covered by T028, but add an explicit assertion in `app/tests/integration/conversation-fns.test.ts` that an externally updated summary appears in the next fetch)

### E2E (US3, full path)

- [ ] T052 [US3] Extend `app/tests/e2e/customer-context.spec.ts` with a summary scenario:
   - Seed a conversation with >2000 chars of messages spanning inbound + outbound (or call DB seed helper)
   - Trigger summary by inserting one more message via the existing send-reply path
   - Poll (max 30s) until `AiPersonaSummary` shows non-empty text
   - Assert disclaimer text is present
   This requires either LocalStack SQS or the in-process fallback from quickstart.md §3 Option B. Document which path the test uses in a comment

**Checkpoint**: 要約パイプラインが文字数閾値で発火し、`conversations.summary` を更新する。AI ドラフトプロンプト (foundational で対応済) は summary を含む。CustomerPanel に AI 認識像が表示される。Story 3 はこの時点で出荷可能。

---

## Phase N: Polish & Cross-Cutting Concerns

**Purpose**: 回帰確認、ドキュメント、品質ゲート、デプロイ前最終チェック。

- [ ] T053 [P] Run `npx paraglide-js compile --project ./project.inlang` in `app/` and commit only the JSON files (per 002 convention) — confirm no compile error
- [ ] T054 [P] Run `npm run lint` and `npm run typecheck` in both `app/` and `ai-worker/` — fix any new warnings introduced by the schema additions or new files
- [ ] T055 [P] Run `npm test` in both `app/` and `ai-worker/` — confirm all existing tests pass (regression) + all new tests added in T013-T014, T020, T030-T031, T039, T049, T051 pass

<!-- unit: U5.1 | deps: U4.1 | scope: infra | tasks: T056-T057 | files: 0 | automation: manual -->
**Unit U5.1 (Manual verification — out-of-PR)**: U4.1 マージ後に運用者が個別に実施。Routine playbook は `automation: manual` を skip するため PR は作らない。手順は quickstart.md §5 と spec.md SC-007 を参照。

- [ ] T056 Run `terraform plan` in `terraform/envs/review/` — verify the diff matches quickstart.md §5 expectation (1 new SQS queue + 1 new DLQ + 1 new event source mapping + IAM/env changes on existing modules, ZERO new Lambda functions / SSM params / DB tables)
- [ ] T057 Verify SC-007 (backward compat) manually: create a fresh conversation with all 5 new columns NULL and the page custom_prompt NULL. Trigger an AI draft via inbound webhook. Confirm via CloudWatch / local logs that:
   - `draft_prompt_composed` event shows `page_prompt_present=false, tone_present=false, customer_prompt_present=false, summary_present=false`
   - The Anthropic system field contains only BASE_SYSTEM_PROMPT
   - A draft is produced successfully

- [ ] T058 [P] Update `docs/explanations/` (or add a new file `docs/explanations/customer-context-and-settings.md`) — short operator-facing doc explaining the Settings page, CustomerPanel, and the summary pipeline. Reference the 5-segment system prompt composition. Note that internal `note` field is not sent to AI
- [ ] T059 Run the full quickstart.md validation sequence (§§ 2-6) on a clean local environment — record any drift between the doc and reality and update quickstart.md if needed
- [ ] T060 Verify Constitution Check ゲート 6/6 are still PASS at end of implementation (add a brief paragraph to plan.md "Phase 1 設計後の再チェック" section confirming actual implementation matched the design)

---

## Dependencies & Execution Order

### Unit (PR) 単位の依存

本機能は **4 つの auto PR + 1 つの manual ステップ**で構成される。Routine playbook が 1 Unit = 1 PR を発行する。

```
U1.1 Foundation
  ├─→ U2.1 Settings (US1)
  └─→ U3.1 CustomerPanel (US2)
              └─→ U4.1 Summary Pipeline + Polish (US3)
                       └─→ U5.1 Manual verification (PR 作らない)
```

| Unit | tasks | scope | automation | deps | wall-clock 順序 |
|------|-------|-------|------------|------|---|
| U1.1 | T001-T017 | backend | auto | none | 最初に必ず |
| U2.1 | T018-T027 | frontend | auto | U1.1 | U1.1 マージ後、U3.1 と並列可 |
| U3.1 | T028-T039 | frontend | auto | U1.1 | U1.1 マージ後、U2.1 と並列可 |
| U4.1 | T040-T055,T058-T060 | backend | auto | U1.1, U3.1 | U3.1 マージ後 (AiPersonaSummary placeholder 必須) |
| U5.1 | T056-T057 | infra | manual | U4.1 | U4.1 マージ後、運用者が手動実施 |

### タスク単位の並列実行

各 Unit (PR) 内では以下が並列実行可能。Routine は通常 1 セッション = 1 Unit を逐次実行するが、`[P]` を付けたタスクは Routine 内のサブステップとして並列に進められる。

- **U1.1**: T002 / T003 / T004 を並列、T006 を T005 と並列、T011 を T009/T010 と並列、T013 / T015 / T016 / T017 を並列
- **U2.1**: T018 / T019 を並列、T022 / T023 / T024 を並列、T025 / T026 は単独
- **U3.1**: T029 を T028 と並列、T032-T036 を並列、T037 は単独
- **U4.1**: T040 / T043 / T044 を並列、T041 / T042 は直列、T046-T049 は直列気味、T050-T052 はバックエンド完了後

### Within Each User Story

- Server fn → コンポーネント → E2E の順
- 同 Story 内の異なるコンポーネントファイル (`[P]` が付くもの) は並列可

---

## Parallel Example: U1.1 Foundation

```bash
# Routine セッション開始後、依存のないタスクから並列実行:
Task T002: "Create app/src/lib/settings/char-limits.ts"
Task T003: "Mirror constants in ai-worker/src/config.ts"
Task T004: "Add env vars to .env.example"
Task T015: "Implement AutoSaveBadge component"
Task T016: "Add i18n key skeleton entries"
Task T017: "Add 3-column layout CSS"
```

その後 T005 → T006-T008 → T009-T012 → T013-T014 を逐次。1 PR で 17 タスク完了。

## Parallel Example: U4.1 Summary Pipeline

```bash
# U3.1 マージ後、依存のないタスクから:
Task T040: "Add SQS queue ai-summary-queue in terraform/envs/review/main.tf"
Task T043: "Implement maybeEnqueueSummaryJob in app/src/server/services/summary-trigger.ts"
Task T044: "Wire trigger into webhook/src/handler.ts inbound path"
Task T046: "Implement buildSummaryPrompt in ai-worker/src/prompt.ts"
Task T058: "Update docs/explanations/"
```

T041 / T042 (Terraform 整合), T045 (app outbound 経路), T047-T049 (summary processor), T050-T052 (UI + E2E), T053-T055 (一括 polish) は依存解決後に逐次。

---

## Implementation Strategy

### MVP First (U1.1 + U2.1 のみ)

1. **U1.1 Foundation PR** をマージ → 全 Story の土台が揃う
2. **U2.1 Settings PR** をマージ → Settings 画面でカスタムプロンプトを保存できる
3. **STOP and VALIDATE**: ページポリシーが AI ドラフトに反映されることを確認
4. ここで「ハードコードプロンプト → ページ単位カスタマイズ可能」の価値が出るためデモ / 早期出荷可能

### Incremental Delivery

1. **U1.1 PR** → Foundation 完成
2. **U2.1 PR** → Settings + ページ単位プロンプト → MVP 出荷
3. **U3.1 PR** → CustomerPanel + 顧客単位設定 → 第二リリース
4. **U4.1 PR** → 要約パイプライン + AI 認識像表示 + Polish → 第三リリース
5. **U5.1 manual** → terraform plan 目視 + SC-007 回帰 → 本番デプロイ準備完了

### Parallel Team Strategy

複数開発者の場合:

1. **U1.1** を 1 人で完成 → マージ (クリティカルパス、並列化不可)
2. U1.1 マージ後:
   - 開発者 A: **U2.1** (Settings)
   - 開発者 B: **U3.1** (CustomerPanel)
   - 同時並走可能 (両 PR の touch ファイル群が完全分離: Settings は `/settings/` 配下、CustomerPanel は `threads/$id/` 配下)
3. **U3.1** マージ後に開発者 A or B が **U4.1** に着手 (U2.1 とは独立で並走しても可、ただし `ai-worker/src/handler.ts` で軽い競合の可能性あり)
4. U4.1 マージ後、運用者が **U5.1** (手動) を実施 → 本番デプロイ

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- 005-008 のマイグレーション系は本番 RDS に作用するため、staging 相当環境での適用確認を必ず先行する
- ai-worker は 2 つの SQS queue を消費するため、本番デプロイ前に Lambda の reserved concurrency を確認 (既存 draft 処理が summary 処理によって starvation しないこと)
- 要約パイプラインは `SUMMARY_PIPELINE_ENABLED=false` で即時無効化できる (research.md R-006)。本番障害時はまずこれをトグル
- 内部メモ (`note`) が AI プロンプトに渡らない設計は T013 (関数シグネチャレベル) と T031 (実際の draft 生成での非混入) の二重防衛で固定
- 文字数閾値 2,000 は env 変数で調整可能 (`SUMMARY_TRIGGER_THRESHOLD_CHARS`)。本番運用 2 週間で生成頻度・コスト・品質を観察してチューニング
- Avoid: 既存 ai-worker テスト (`handler.test.ts`) を壊さない (SC-007)。T014 で明示的に回帰ガードを敷く
