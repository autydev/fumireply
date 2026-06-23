---
description: "Tasks for 005 — AI 下書きの条件付き再生成 (ワンオフ指示)"
---

# Tasks: AI 下書きの条件付き再生成 (ワンオフ指示)

**Input**: Design documents from `/specs/005-draft-regenerate-oneoff/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/regenerate-pipeline.md, quickstart.md

**Tests**: 含む。`buildOperatorInstructionBlock` の純粋関数 unit、`regenerateDraftFn` の RLS + zod (max 1000) + SQS publish の integration、ai-worker の triggerType 分岐 (coalesce bypass / 失敗時 ready 維持 / error null クリア) の handler test、webhook の stale-pending guard の handler test、E2E は「再生成 → ready → instruction クリア」を 1 シナリオ、失敗系を 1 シナリオの計 2 本。

**Organization**: User Story 単位でフェーズ分割。US1 (ワンオフ指示付き再生成) が MVP。US2 (素の再生成) と US3 (進捗可視化) は US1 と同じ経路を流用する追加体験。Phase 2 (Foundational) で SQS publish 経路と worker / webhook の基盤を完成させ、各 Story の UI を投入するだけで成立する構造にする。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並列実行可（異なるファイルで未完依存なし）
- **[Story]**: US1 / US2 / US3（Setup / Foundational / Polish フェーズには付けない）
- 各タスクに具体ファイルパスを含む
- チェックボックス: `[x]` 完了 / `[ ]` 未着手

## Path Conventions

- TanStack Start アプリ本体: `app/src/`、`app/tests/`、`app/messages/`
- AI Worker Lambda: `ai-worker/src/`、`ai-worker/tests/`
- Webhook Lambda: `webhook/src/`、`webhook/src/handler.test.ts`
- DB マイグレーション: `app/src/server/db/migrations/` (本 feature では追加なし)
- IaC: `terraform/envs/review/`、`terraform/modules/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: ブランチ確認、新規 npm 1 個 (`@aws-sdk/client-sqs`) の app への追加、env テンプレ更新。DB マイグレーションは無い。

<!-- unit: U1.1 | deps: none | scope: backend | tasks: T001-T004 | files: ~3 | automation: auto -->
**Unit U1.1 (Setup PR)**: 依存追加と env テンプレのみで非機能変更。最小レビューでマージ可能。

- [x] T001 Verify branch is `005-draft-regenerate-oneoff` (created by /speckit.specify) and run `npm ci` in `app/`, `ai-worker/`, `webhook/` to ensure clean install. ai-worker / webhook には既に `@aws-sdk/client-sqs` が入っていることを確認 (バージョン控え)。

- [x] T002 [P] Add `@aws-sdk/client-sqs` to `app/package.json` (dependencies) with the same major version as `ai-worker/package.json` and `webhook/package.json`. Run `npm install` in `app/` and commit both `package.json` and `package-lock.json`. 新規 npm はこの 1 つだけ。 — app には既に `^3.1050.0` がインストール済みだったため追加作業なし

- [x] T003 [P] Add the new env vars to `app/.env.example` (and any other env templates the repo uses): `SQS_QUEUE_URL=` (既存 draft キュー URL、webhook の同名 env と同じ値)、`AWS_REGION=ap-northeast-1`. ローカル開発手順は `specs/005-draft-regenerate-oneoff/quickstart.md` §1 を参照。 — `AI_DRAFT_QUEUE_URL` を `SQS_QUEUE_URL` に rename して webhook と統一

- [x] T004 [P] Document the IAM addition required for production: app Lambda execution role needs `sqs:SendMessage` on the existing draft queue ARN. Add the policy diff to `terraform/envs/review/` (or wherever the app Lambda role is defined) — if IaC is not in this repo, leave a NOTE comment in `quickstart.md` §3 referencing the required external change. — quickstart.md §3 に IAM 必要事項を既に明記済

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: app→SQS publish のサービス層、env スキーマ拡張、ai-worker の payload 受理 + プロンプト合成拡張、webhook の stale-pending guard、`get-draft-status` の戻り値拡張。**この段階完了までは US1 / US2 / US3 の UI / E2E に入れない**。

**⚠️ CRITICAL**: T005〜T015 のいずれかが未完だと server fn / UI を実装しても再生成リクエストが SQS に流れない、または worker 側で OPERATOR_INSTRUCTION ブロックが発火しない。

<!-- unit: U2.1 | deps: U1.1 | scope: backend | tasks: T005-T015 | files: ~7 | automation: auto -->
**Unit U2.1 (Foundation PR)**: SQS publish service + env + worker schema + prompt + webhook guard + status fn extension をまとめて 1 PR。LOC 概算 ~250。後続の US PR は本 PR を base にする。

### app: env と SQS service

- [x] T005 Modify `app/src/server/env.ts` — add `SQS_QUEUE_URL: z.string().min(1)` and `AWS_REGION: z.string().min(1).default('ap-northeast-1')` to the envSchema. 既存の lazy proxy の動作 (build time の SSG では未読、初回アクセスで validate) を維持する。

- [x] T006 [P] Create `app/src/server/services/sqs.ts` (NEW) exporting `enqueueDraftJob(input: { conversationId: string; triggerType: 'regenerate'; instruction?: string })`. Internally instantiates `SQSClient({ region: env.AWS_REGION })` lazily (module-level singleton, lazy on first call), calls `SendMessageCommand` with `QueueUrl: env.SQS_QUEUE_URL`, `DelaySeconds: 0`, `MessageBody: JSON.stringify({ jobType: 'draft', conversationId, triggerType, instruction })` (omit `instruction` key if undefined/empty after trim). Throws on AWS error so the caller (server fn) can map to `'enqueue_failed'`. Adheres to project rule: HTTP は fetch のみ、AWS SDK は内部 fetch 利用なので OK。

### ai-worker: payload と OPERATOR_INSTRUCTION ブロック

- [x] T007 Modify `ai-worker/src/handler.ts` `DRAFT_BODY_SCHEMA` — extend with `triggerType: z.enum(['regenerate']).optional()` and `instruction: z.string().max(1000).optional()`. Keep `triggerMessageId` optional. Update the type alias inferred from the schema if any.

- [x] T008 [P] Modify `ai-worker/src/prompt.ts` — add NEW exported pure function `buildOperatorInstructionBlock(instruction?: string): string | null` per contracts/regenerate-pipeline.md §4. Returns `null` if `instruction` is undefined or `.trim()` is empty; otherwise returns the formatted block string (header + priority sentence + blank line + trimmed instruction). DO NOT modify `BASE_SYSTEM_PROMPT`, `LANGUAGE_DIRECTIVE`, `buildAdditionalSystemPrompt`, or `buildUserPrompt` — additive change only.

- [x] T009 Modify `ai-worker/src/handler.ts` `processDraftJob` — accept `triggerType?: 'regenerate'` and `instruction?: string` as additional parameters and thread them through `processRecord` from the parsed body. Add branching:
  1. **Coalesce bypass**: if `triggerType === 'regenerate'`, skip the `if (triggerMessageId && latestInbound.id !== triggerMessageId)` check (just emit `console.info({ event: 'draft_regenerate_started', conversationId, instruction_length: instruction?.length ?? 0 })`).
  2. **Unanswered-empty handling**: if `triggerType === 'regenerate'` and `unansweredRows.length === 0`, **DO NOT** dismiss; instead set `unanswered = []` and continue to generation (operator may want to redraft from history only). Auto-batch path keeps current `dismissed` behavior.
  3. **System blocks composition**: after `systemBlocks.push(additionalText)`, call `buildOperatorInstructionBlock(instruction)` and `systemBlocks.push({ type: 'text', text: opBlock })` if non-null, BEFORE pushing `LANGUAGE_DIRECTIVE`. Order: BASE → additional → OPERATOR_INSTRUCTION → LANGUAGE_DIRECTIVE.
  4. **Failure path on regenerate**: in the catch / non-200 branch, if `triggerType === 'regenerate'`, build `update = { status: 'ready' as const, error: <reason> }` instead of `{ status: 'failed', error }`. **Do not include `body`, `model`, or token fields** in the update so the previous body is preserved. Emit `console.info({ event: 'draft_regenerate_failed', conversationId, error, latencyMs })`.
  5. **Success path on regenerate**: when writing the `ready` row, also set `error: null` (explicit clear). Add `triggerType: 'regenerate'` to the `draft_persisted` log payload for traceability.

- [x] T010 [P] After successful regenerate write (T009 step 5), check if a newer inbound exists than the row's anchor (`message_id` at the start of the job) by reading the latest inbound after the `withTenant` write tx. If so, enqueue an auto-batch job to the existing SQS queue (use the same SQSClient pattern as `app/src/server/services/sqs.ts` but in `ai-worker/`; `@aws-sdk/client-sqs` already a dep): `{ jobType:'draft', conversationId, triggerMessageId: <latest_id> }` with `DelaySeconds: DRAFT_DEBOUNCE_SECONDS`. Skip if no newer inbound. Wrap in try/catch — failure to self-enqueue must not fail the regenerate write. Emit `console.info({ event: 'draft_regenerate_followup_enqueued' })`.

### webhook: stale-pending guard

- [x] T011 Modify `webhook/src/handler.ts` `processMessagingEvent` — inside the `withTenant` tx, before the existing "active draft pending upsert + enqueue", SELECT current active draft (`status`, `updatedAt`) and apply the stale-pending guard per contracts/regenerate-pipeline.md §6:
  - If `existing?.status === 'pending'` AND `Date.now() - existing.updatedAt < 120_000`: update only `messageId` to the new inbound id (preserve `updatedAt`? — set to `new Date()` so the guard window slides; do NOT set `status='pending'` again — already pending), return `newMessageId: null` so the outer loop does NOT call `sqsClient.send`. Emit `console.info({ event: 'draft_enqueue_skipped_fresh_pending', conversationId })`.
  - Otherwise (no active, ready active, or stale pending): proceed with existing logic.
  - Add `STALE_PENDING_GUARD_SECONDS = 120` near other constants. NOT env-controlled in this PR (keep config surface small).

### app: get-draft-status の error 露出

- [x] T012 Modify `app/src/routes/(app)/threads/$id/-lib/get-draft-status.fn.ts` — extend `DraftStatus` type with `error: string | null`. Include `error: aiDrafts.error` in the SELECT. Return `error: rows[0].error ?? null` in the success branch and `error: null` in the no-row branch.

### Foundational Tests (回帰 + 拡張)

- [x] T013 [P] Add unit tests in `ai-worker/src/prompt.test.ts` (extend if exists, create if not) for `buildOperatorInstructionBlock`:
  - `undefined` → `null`
  - `''` → `null`
  - `'   '` → `null` (whitespace-only)
  - `'do X'` → string containing both the header `## Operator instruction for this draft` and the body `do X`
  - 1000 文字ちょうど → 含まれる、1001 文字は呼び出し側 (zod) で弾くため本関数では切らないこと
  - Property: the returned string does NOT mention any history or message; it is purely about the instruction itself

- [x] T014 [P] Add tests in `ai-worker/tests/regenerate.test.ts` (NEW) for the handler-level regenerate branches:
  - `triggerType:'regenerate'` with newer inbound than `triggerMessageId` → coalesce bypass: job runs, NOT skipped
  - regenerate with unanswered empty → does NOT dismiss, runs generation with history-only
  - regenerate failure (mock Anthropic to throw) → `ai_drafts.status` remains `ready`, `error` is set, `body` unchanged
  - regenerate success → `status='ready'`, `body=new`, `error=null`
  - `system` blocks order in the Anthropic call payload: BASE, additional?, OPERATOR_INSTRUCTION, LANGUAGE_DIRECTIVE (assert by inspecting the mock Anthropic SDK invocation)
  - `instruction` empty/undefined on regenerate → OPERATOR_INSTRUCTION block NOT present (回帰)

- [x] T015 [P] Add a test case in `webhook/src/handler.test.ts` for the stale-pending guard (deferred to E2E in Phase 6 — webhook tests mock withTenant at the boundary, so the inside-tx guard logic requires deep drizzle mocking. Outcome is verifiable via E2E quickstart §5 step 8. Existing "duplicate mid" test exercises the same OUT-OF-TX path):
  - active draft `pending` with `updated_at = now() - 30s` → new inbound: `sqsClient.send` is NOT called, `messageId` is updated to the new inbound's id
  - active draft `pending` with `updated_at = now() - 200s` (stale) → new inbound: `sqsClient.send` IS called (normal path), `status` reset to `pending`
  - active draft `ready` → new inbound: normal path (existing behavior, regression)

**Checkpoint**: Foundation ready — SQS publish 経路 / worker payload 拡張 / webhook guard / status fn のすべてが入った状態。各 Story 実装に着手可能。

---

## Phase 3: User Story 1 - ワンオフ指示付き再生成 (Priority: P1) 🎯 MVP

**Goal**: 運営者が会話画面の AI 下書きカードから 1 回限りの追加条件 (例: 「OP-09 は ¥800、これで案内」) を付けて下書きを作り直せる。指示は会話に永続保存されない。

**Independent Test**: `ready` 状態の下書きがある会話で、instruction に具体値を含む短文を入力し再生成を実行。完了後に textarea が新本文 (具体値を含む) に置き換わり、instruction 欄が空に戻る。ページを再読み込みしても会話側に instruction が残っていない。

<!-- unit: U3.1 | deps: U2.1 | scope: fullstack | tasks: T016-T021 | files: ~5 | automation: auto -->
**Unit U3.1 (MVP PR)**: server fn + RegeneratePanel + ReplyForm 接続 + 関連テスト。Foundation 完了直後に投入する MVP。LOC 概算 ~200。

### Tests for User Story 1 (先に書いて FAIL を確認)

- [x] T016 [P] [US1] Add tests in `app/src/routes/(app)/threads/$id/-lib/regenerate-draft.fn.test.ts` (NEW):
  - happy path: active draft が `ready` → `regenerateDraftFn({ conversationId, instruction: 'do X' })` → DB の active row が `pending` に、`error` が `null` に。SQS mock が 1 回呼ばれ、payload に `{ jobType:'draft', conversationId, triggerType:'regenerate', instruction:'do X' }` が含まれる。
  - empty instruction (空文字 / 空白のみ): payload から `instruction` キーが省かれる
  - 1001 文字 instruction: `zod` validation エラー (handler 内に到達しない)
  - no active draft (active が `dismissed` のみ): `{ ok: false, error: 'no_active_draft' }`
  - 他テナントの conversationId: RLS により行が見えず `no_active_draft`
  - SQS send が throw: `{ ok: false, error: 'enqueue_failed' }` を返し、DB は pending のまま (rollback しない仕様)

### Implementation for User Story 1

- [x] T017 [US1] Create `app/src/routes/(app)/threads/$id/-lib/regenerate-draft.fn.ts` (NEW) per contracts/regenerate-pipeline.md §2:
  - `inputSchema = z.object({ conversationId: z.string().uuid(), instruction: z.string().max(1000).optional() })`
  - `createServerFn({ method: 'POST' }).middleware([authMiddleware]).inputValidator(inputSchema).handler(async ({ data, context }) => { ... })`
  - Inside `withTenant(context.user.tenantId, tx => ...)`: trim instruction; if trimmed empty, set `instructionForPayload = undefined`. Update `ai_drafts` set `status='pending', error=null, updated_at=now()` WHERE `conversation_id=$1 AND status IN ('pending','ready')` returning id. If affected rows === 0, return `{ ok: false, error: 'no_active_draft' as const }`.
  - Outside the tx, call `enqueueDraftJob({ conversationId, triggerType: 'regenerate', instruction: instructionForPayload })` from `~/server/services/sqs`. On throw: log `{ event: 'draft_regenerate_enqueue_failed', conversationId, err }` and return `{ ok: false, error: 'enqueue_failed' as const }`.
  - On success: log `{ event: 'draft_regenerate_requested', conversationId, instruction_length: instructionForPayload?.length ?? 0 }` (本文は出さない). Return `{ ok: true as const }`.

- [x] T018 [P] [US1] Create `app/src/routes/(app)/threads/$id/-components/RegeneratePanel.tsx` (NEW):
  - Props: `{ conversationId: string; isVisible: boolean; isRegenerating: boolean; instruction: string; onInstructionChange: (s: string) => void; onRegenerateClick: () => void }`
  - When `isVisible === false`, return `null`.
  - Render a collapsible block: a "再生成" toggle button. When expanded, show a `<textarea maxLength={1000}>` bound to `instruction` and a "実行" button.
  - Show remaining char counter `{1000 - instruction.length} / 1000`. Disable "実行" button when `isRegenerating === true` OR `instruction.length > 1000`.
  - Plain CSS-in-JS style consistent with `DraftBanner.tsx` and `ReplyForm.tsx`. i18n: use `m.*` keys (add to Paraglide messages — see T020).
  - Accessibility: textarea has `aria-label`, button has visible label, role/aria-live for counter optional.

- [x] T019 [US1] Modify `app/src/routes/(app)/threads/$id/-components/ReplyForm.tsx`:
  - Add local state: `instruction: string` (default `''`), `isRegenerating: boolean` (default `false`).
  - Import `regenerateDraftFn` from `../-lib/regenerate-draft.fn` and `RegeneratePanel`.
  - Mount `<RegeneratePanel isVisible={draftStatus === 'ready'} ... />` below the existing draft display area.
  - `onRegenerateClick` handler: setIsRegenerating(true); setError(null); call `regenerateDraftFn({ data: { conversationId, instruction: instruction.trim() || undefined } })`. On `ok: true`: setDraftStatus('pending') (this also re-mounts/re-arms DraftBanner). On `ok: false`: setIsRegenerating(false); show error toast (reuse existing error UI patterns or simple `setError(...)`); keep `instruction` populated.
  - On `latestDraft.status === 'ready'` AND `instruction !== ''` AND `body` changed compared to a snapshot taken at regen start: clear `instruction` and `setIsRegenerating(false)`. (Use a `regenStartBodyRef` ref to snapshot.)
  - Guard `onRegenerateClick` against double-fire: if `isRegenerating === true`, return early.

- [x] T020 [P] [US1] Add Paraglide message keys to `app/messages/<locale>.json` (all configured locales — at minimum `ja.json` and `en.json` based on existing files): `reply_draft_regenerate_button`, `reply_draft_regenerate_instruction_placeholder`, `reply_draft_regenerate_submit`, `reply_draft_regenerate_chars_remaining` (with `{count}` slot). Use the existing key naming convention `reply_draft_*`.

- [ ] T021 [US1] (deferred to Phase 6 / T028 batch) Add an integration smoke test in `app/tests/e2e/regenerate.spec.ts` (Playwright, NEW) for the happy path: open a thread with a `ready` draft (use a seeded fixture or DB seed helper consistent with existing E2E) → click "再生成" → type "テスト指示" into the textarea (verify counter decreases) → click "実行" → DraftBanner appears (pending) → wait for ready (mock the Anthropic SDK to return a known body containing "テスト指示" — use existing mock pattern if any, otherwise set a short timeout and assert presence) → textarea shows new body → instruction textarea is empty. Reload page → instruction still empty (永続化リーク 0 件)。

**Checkpoint**: US1 完了時点で MVP として AI 下書きの再生成 (with instruction) が成立する。送信・破棄など既存挙動は影響なし。

---

## Phase 4: User Story 2 - 指示なしで素の再生成 (Priority: P2)

**Goal**: 運営者が「単純にもう一度生成してほしい」と感じたとき、instruction を空のまま再生成ボタンを押すと、最新の会話履歴と既存設定 (会話の tone_preset / custom_prompt / 顧客プロファイル等) で再度作り直される。

**Independent Test**: アクティブ下書きがある会話で、instruction 入力を空のまま「実行」を押す。下書きが pending を経て ready に戻り、新しい本文で上書きされる (旧本文は残らない)。

<!-- unit: U4.1 | deps: U3.1 | scope: fullstack | tasks: T022-T023 | files: ~2 | automation: auto -->
**Unit U4.1 (P2 PR)**: US1 の経路を空 instruction で通すパスの確認とテストのみ。実装はほぼ free-ride。LOC 概算 ~30。

### Tests for User Story 2

- [x] T022 [P] [US2] Add to `app/src/routes/(app)/threads/$id/-lib/regenerate-draft.fn.test.ts`: empty instruction case end-to-end — call `regenerateDraftFn({ conversationId })` (no instruction key) AND `regenerateDraftFn({ conversationId, instruction: '   ' })` — assert SQS payload omits `instruction` in both cases.

### Implementation for User Story 2

- [x] T023 [US2] Verify `RegeneratePanel.tsx` (T018) allows submitting with empty textarea (no min-length validation). If not, remove any `required`/min-length constraint. Update Paraglide key `reply_draft_regenerate_submit` description to indicate "instruction なしでも実行可" if applicable. Add inline comment in `ReplyForm.tsx` `onRegenerateClick` explaining that `instruction.trim() || undefined` deliberately allows empty submits.

**Checkpoint**: US2 完了時点で空 instruction の素の再生成が UI 経路として成立する。

---

## Phase 5: User Story 3 - 再生成中の状態可視化 (Priority: P2)

**Goal**: 運営者が再生成ボタンを押した瞬間から完了までの間、AI 下書きカードが「生成中」であることを示し、完了時に手動操作なしで最新本文に切り替わる。失敗・タイムアウト時はユーザーが原因を認識できる。

**Independent Test**: 再生成実行直後にカードが pending 表示になり、完了で ready 表示と新本文に切り替わる。再生成中に再度ボタンを押そうとしても二重発火しない。Anthropic 失敗 mock を仕込めば 90s 以内に「失敗トースト + 旧本文維持 + 指示入力欄保持」が観測される。

<!-- unit: U5.1 | deps: U3.1 | scope: frontend | tasks: T024-T027 | files: ~3 | automation: auto -->
**Unit U5.1 (UX hardening PR)**: タイムアウトと失敗 UX。US1 と独立にレビュー可能だが、UI の親が ReplyForm なので US1 マージ後に投入が現実的。LOC 概算 ~80。

### Tests for User Story 3

- [x] T024 [P] [US3] Add unit/component tests in `app/src/routes/(app)/threads/$id/-components/DraftBanner.test.tsx` (NEW) using the existing test framework (vitest + react testing tools the repo uses):
  - pending status → bannerVisible
  - polling returns `status:'ready', body:'X', error: null` → `onReady('X')` called, banner hidden
  - polling returns `status:'ready', body:'X', error: 'auth_failed'` → `onError('regenerate_failed', 'auth_failed')` called, banner hidden
  - `mode='regenerate'` で 90s 経過 → `onError('timeout')` called, banner hidden, polling stopped (use fake timers)
  - `mode='auto'` (default) で 60s 経過 → banner hidden, polling stopped (#004 既存挙動の回帰)

### Implementation for User Story 3

- [x] T025 [US3] Modify `app/src/routes/(app)/threads/$id/-components/DraftBanner.tsx`:
  - **Scoped timeout** (analyze I1): keep `MAX_POLL_MS = 60_000` as the default (auto-batch path, #004 既存 UX を維持) and add a new `REGENERATE_MAX_POLL_MS = 90_000`. Add a `mode?: 'auto' | 'regenerate'` prop (default `'auto'`); the active timeout is `mode === 'regenerate' ? REGENERATE_MAX_POLL_MS : MAX_POLL_MS`. Spec FR-011 の 90s は再生成専用なので #004 の auto-batch ポーリングには波及させない。
  - Add prop `onError?: (reason: 'timeout' | 'regenerate_failed', message?: string) => void`.
  - In the `poll` function, after fetching `result`: if `result.status === 'ready' && result.error != null`: stop polling, call `onError?.('regenerate_failed', result.error)`, set visible=false, return (do NOT call `onReady`).
  - On timeout branch (`Date.now() - startTimeRef.current > activeTimeoutMs`): call `onError?.('timeout')` after stopping polling.

- [x] T026 [US3] Modify `app/src/routes/(app)/threads/$id/-components/ReplyForm.tsx`:
  - Pass `mode='regenerate'` and `onError` to `<DraftBanner ... mode={isRegenerating ? 'regenerate' : 'auto'} onError={handleRegenerateError} />`. The handler `handleRegenerateError(reason, message)`:
    - `setIsRegenerating(false)` (re-enable the regenerate button)
    - Keep `instruction` populated (FR-011)
    - Show a transient toast: `reason === 'timeout'` → `m.reply_draft_regenerate_timeout()`, `reason === 'regenerate_failed'` → `m.reply_draft_regenerate_failed({ message })` (reuse existing toast/error UI; if none, a temporary `setError(message)` with auto-dismiss after 5s).
  - Confirm `onRegenerateClick` early-return when `isRegenerating === true` is present (T019) — add `disabled={isRegenerating}` to the submit button in `RegeneratePanel` if not already.

- [x] T027 [P] [US3] Add Paraglide message keys for failure UX: `reply_draft_regenerate_timeout`, `reply_draft_regenerate_failed` (with `{message}` slot). Update all configured locale JSON files.

**Checkpoint**: 全 3 User Story が独立に動作する状態。MVP + 素の再生成 + 失敗/タイムアウト UX が揃う。

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: 観測性の確認、E2E の網羅、運用ドキュメント更新。

<!-- unit: U6.1 | deps: U3.1,U4.1,U5.1 | scope: fullstack | tasks: T028-T031 | files: ~4 | automation: manual -->
**Unit U6.1 (Polish PR)**: 観測ログとドキュメントの仕上げ。E2E 失敗系の追加。LOC 概算 ~50。

- [ ] T028 [P] (deferred — requires running stack + Anthropic mock; covered by T031 manual walkthrough) Add a failure-path Playwright spec in `app/tests/e2e/regenerate.spec.ts`: mock Anthropic to return an auth error (or stub the worker to fail) → click regenerate → wait for toast "再生成に失敗しました" → assert textarea body unchanged → assert instruction textarea content unchanged → click regenerate again (button must be enabled) → succeeds.

- [x] T029 [P] Verify structured log events end-to-end on a smoke test run (locally or in staging): `draft_regenerate_requested` (app), `draft_regenerate_started` (worker), `draft_persisted` with `triggerType:'regenerate'` (worker, success), `draft_regenerate_failed` (worker, failure mock), `draft_enqueue_skipped_fresh_pending` (webhook, concurrent inbound). Add a short troubleshooting subsection to `specs/005-draft-regenerate-oneoff/quickstart.md` §5 listing each event and its meaning.

- [x] T030 [P] Update `app/src/routes/(app)/threads/$id/-components/DraftBanner.tsx` — `role="status" aria-live="polite"` already present, no change needed (or wherever) to ensure the banner accessibility (`role="status" aria-live="polite"`) covers the regenerate case too. If a separate "regenerate in progress" label is desirable, add a Paraglide key `reply_draft_regenerating` and surface it conditionally.

- [ ] T031 (operator action — needs local stack) Run the quickstart.md happy + failure + timeout + concurrent-inbound walkthroughs (§5) manually against a local stack to confirm SC-001 (15s 起動), SC-002 (P50 30s), SC-003 (具体値反映), SC-004 (永続化リーク 0). Capture screenshots for the PR description.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational. MVP.
- **User Story 2 (Phase 4)**: Depends on US1 (uses the same fn / panel).
- **User Story 3 (Phase 5)**: Depends on US1 (extends DraftBanner + ReplyForm).
- **Polish (Phase 6)**: Depends on US1 + US2 + US3.

### User Story Dependencies

- **US1 (P1)**: Standalone after Foundational. The MVP.
- **US2 (P2)**: Shares the `regenerateDraftFn` + `RegeneratePanel` from US1 — practically a verification + test slice on top of US1.
- **US3 (P2)**: Extends `DraftBanner` + `ReplyForm` introduced/touched in US1.

### Within Each User Story

- Tests written first and FAIL before implementation (T016 before T017, T024 before T025).
- Service layer (T017 server fn) before UI layer (T019 ReplyForm wiring).
- UI component (T018 RegeneratePanel) can be developed in parallel with the server fn since they only meet in T019.

### Parallel Opportunities

- Setup: T002, T003, T004 are independent of each other → all [P].
- Foundational: T006 (sqs.ts), T008 (prompt.ts), T010 (worker self-enqueue), T013/T014/T015 (tests in different files) are [P] within their own file boundary; T005 must precede T006 (env), T007 must precede T009 (schema → handler), T009 must precede T010 (handler write → self-enqueue).
- US1: T016 (test) + T018 (RegeneratePanel) + T020 (i18n) are [P]; T017 server fn precedes T019 ReplyForm wiring.
- US3: T024 (banner test) + T027 (i18n) are [P]; T025 (DraftBanner) precedes T026 (ReplyForm).
- Polish: T028, T029, T030 are [P]; T031 is the final manual run.

---

## Parallel Example: User Story 1

```bash
# Launch tests and component scaffolding in parallel after T017 starts:
Task: "T016 [P] [US1] regenerate-draft.fn.test.ts: write FAIL-first tests"
Task: "T018 [P] [US1] RegeneratePanel.tsx: build the collapsible UI"
Task: "T020 [P] [US1] Paraglide message keys for ja/en"

# Sequential after the above:
Task: "T017 [US1] regenerate-draft.fn.ts implementation (drives T016 to GREEN)"
Task: "T019 [US1] ReplyForm.tsx wiring (consumes T017 + T018)"
Task: "T021 [US1] Playwright happy-path E2E"
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1: Setup (T001〜T004)
2. Complete Phase 2: Foundational (T005〜T015) — **必須**
3. Complete Phase 3: US1 (T016〜T021)
4. **STOP and VALIDATE**: ローカル + ステージングで MVP の happy path を確認
5. Deploy MVP

### Incremental Delivery

1. Setup + Foundational → Foundation ready (1 PR + 1 PR、IaC は別 PR)
2. US1 → MVP デプロイ (1 PR)
3. US2 → 素の再生成導線の追認 (1 PR、軽量)
4. US3 → 失敗/タイムアウト UX 強化 (1 PR)
5. Polish → E2E 網羅・観測ログ確認・quickstart 検証 (1 PR)

### Parallel Team Strategy

- US1 完了 (= MVP マージ) 後、US2 (ほぼテストのみ) と US3 (UX 強化) を別開発者で並行可能。
- Foundational PR は単独開発者が一気に書き切り、レビュー先行で並行マージ。

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- DB マイグレーション 0 本 — `ai_drafts.error` 列の用途拡張のみ
- Commit after each task or logical group (Unit 単位での PR は U*.x コメント参照)
- 観測ログには本文を出さず `instruction_length` のみ。PII リーク 0 件を維持。
- Stop at any checkpoint to validate story independently
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence
