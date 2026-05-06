---
description: "Tasks for App Review Submission Readiness — Connect Page UI + i18n + submission docs"
---

# Tasks: App Review Submission Readiness

**Input**: Design documents from `/specs/002-app-review-submission/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: 含む。Connect Page server fn の Graph API モック検証、i18n の Cookie 読み書きと SSR locale 反映、forward/reverse guard の動作確認は審査差し戻しリスクを下げるため必須。E2E（Playwright + FB Test User）も Sprint 6 で実施。

**Organization**: User Story 単位でフェーズ分割。Story 間の依存最小化を目指すが、US1（Connect Page UI）は US2（i18n インフラ）の翻訳キー追加 API に依存するため US2 → US1 の順を推奨。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並列実行可（異なるファイルで未完依存なし）
- **[Story]**: US1/US2/US3/US4/US5（Setup/Foundational/Polish フェーズには付けない）
- 各タスクに具体ファイルパスを含む

## Path Conventions

- TanStack Start アプリ本体: `app/src/`、`app/tests/`、`app/messages/`、`app/project.inlang/`
- 撮影補助スクリプト: `scripts/`（リポジトリルート）
- 申請ドキュメント: `docs/review-submission/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 002 ブランチでの依存追加と Paraglide / Facebook App の前提セットアップ。コード変更は最小限で、全 Story の前提を整える。

<!-- unit: U1.1 | deps: none | scope: infra | tasks: T001 | files: 0 | automation: auto -->
- [x] T001 Verify branch is `002-app-review-submission` (created by /speckit.specify) and run `npm ci` in `app/` to ensure clean install

<!-- unit: U1.2 | deps: U1.1 | scope: frontend | tasks: T002-T006 | files: ~5 | automation: auto -->
- [ ] T002 [P] Install Paraglide dev dependency: `npm install --save-dev @inlang/paraglide-js` in `app/package.json`
- [ ] T003 [P] Create `app/project.inlang/settings.json` with sourceLanguageTag=ja, languageTags=[ja,en], plugin.inlang.messageFormat config (per `contracts/locale-fn.md` §4)
- [ ] T004 [P] Create skeleton `app/messages/en.json` and `app/messages/ja.json` with `$schema` reference and an empty body (keys added per-story)
- [ ] T005 Configure Paraglide Vite plugin in `app/vite.config.ts` (per TanStack official example `examples/react/start-i18n-paraglide`)
- [ ] T006 Run `npx paraglide-js compile --project ./project.inlang` once and verify generation succeeds; add `app/paraglide/` to root `.gitignore`

<!-- unit: U1.3 | deps: none | scope: infra | tasks: T007-T009 | files: ~1 | automation: manual -->
- [ ] T007 [P] Add `VITE_FB_APP_ID` to `app/.env.local` (local dev) and document in `app/.env.example` if exists; sync expected env into Lambda env via Terraform module variables (no Terraform diff if value already provisioned)
- [ ] T008 [P] **(Manual)** Verify Meta App Settings: App Domains contains `review.fumireply.ecsuite.work`, Platform=Website with Site URL, Embedded Browser OAuth=Yes — record completion date in `docs/operations/audit-runbook.md`
- [ ] T009 [P] **(Manual)** Create one Facebook Test User under Meta App Roles → Test Users; create one Test Page under that user; store credentials in GitHub Actions secrets `FB_TEST_USER_EMAIL`/`FB_TEST_USER_PASSWORD`/`FB_TEST_PAGE_ID`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: i18n の SSR / Cookie 基盤と Facebook Graph API ラッパー、ガード共通 server fn を整備。**この段階完了までは US1 / US2 の本格実装に入れない**。

**⚠️ CRITICAL**: T010〜T017 のいずれかが未完だと US1 / US2 のコンポーネントを実装してもコンパイル/起動しない可能性が高い。

<!-- unit: U2.1 | deps: U1.2 | scope: frontend | tasks: T010-T013 | files: ~4 | automation: auto -->
- [ ] T010 Implement Cookie helpers in `app/src/lib/i18n/locale.ts` — `getLocaleFromCookieHeader(cookieHeader: string): 'en' | 'ja'`, `serializeLocaleCookie(locale): string`, defaulting to `'ja'` for missing/invalid (per data-model.md §2.1, contracts/locale-fn.md §2)
- [ ] T011 Implement SSR locale middleware in `app/src/lib/i18n/locale-middleware.ts` using `createMiddleware` from `@tanstack/start/server`; reads cookie via T010 helper and calls Paraglide `setLocale()` per request (per contracts/locale-fn.md §2)
- [ ] T012 Wire `localeMiddleware` into `createStart` in `app/src/start.ts` (or equivalent entry) as a global server middleware so every SSR request runs through it
- [ ] T013 Implement `setLocaleFn` server fn in `app/src/lib/i18n/set-locale.fn.ts` — Zod input `{ locale: 'en'|'ja' }`, sets `Set-Cookie: fumireply_locale=...; Path=/; Max-Age=31536000; SameSite=Lax; Secure` (per contracts/locale-fn.md §1)

<!-- unit: U2.2 | deps: U1.2,U1.3 | scope: backend | tasks: T014-T017 | files: ~4 | automation: auto -->
- [ ] T014 [P] Implement Facebook JS SDK loader in `app/src/lib/facebook-sdk.ts` — Promise-cached dynamic `<script src="https://connect.facebook.net/en_US/sdk.js">` injection, exposes `loadFbSdk(appId): Promise<typeof FB>`
- [ ] T015 [P] Implement Graph API wrapper in `app/src/server/services/facebook.ts` with three exports: `exchangeUserToken(shortToken)`, `listPages(longUserToken)`, `subscribePageWebhook(pageId, pageAccessToken)` — all use global `fetch` + `AbortSignal.timeout(10000)` + exponential backoff for 5xx, no axios (per contracts/facebook-graph.md §1〜3, plan.md HTTP クライアント方針)
- [ ] T016 [P] Implement `checkConnectedPagesFn` server fn in `app/src/server/services/check-connected-pages.fn.ts` — returns `{ count: number }` for the JWT's tenant_id (used by both forward and reverse guards, per contracts/connect-page-fn.md §4)
- [ ] T017 [P] Add MSW Graph API handlers in `app/src/test/msw/facebook-handlers.ts` — happy paths for fb_exchange_token, /me/accounts, /{page-id}/subscribed_apps, plus error variants (190, 200, 4, 803) per contracts/facebook-graph.md test matrix

**Checkpoint**: i18n SSR + Cookie が機能、Graph API ラッパーが MSW で叩け、guard の前提 fn が呼べる状態。

---

## Phase 3: User Story 2 — i18n + LanguageToggle (Priority: P1) 🎯 MVP Foundation

**Goal**: screencast 撮影範囲（login / inbox / threads / reply form）を EN/JA 切替可能にする。Header に常時表示の言語トグルを置き、Cookie ベースで選択を永続化する。

**Independent Test**: Header の `EN` をクリック → screencast 範囲の全画面で日本語が消え英訳が出る → ブラウザを再起動しても EN 設定が保持されている、をブラウザ手動で確認できる。Connect Page UI（US1）を未実装でもテスト可能。

### Tests for User Story 2

<!-- unit: U3.1 | deps: U2.1 | scope: frontend | tasks: T018-T020 | files: ~3 | automation: auto -->
- [ ] T018 [P] [US2] Unit test for cookie helpers in `app/tests/integration/locale-cookie.test.ts` — getLocaleFromCookieHeader / serializeLocaleCookie の境界値（無効値、複数値、空文字、未設定）
- [ ] T019 [P] [US2] Integration test for `setLocaleFn` in `app/tests/integration/set-locale-fn.test.ts` — happy path (en, ja) と Zod 失敗ケースで Set-Cookie ヘッダ確認
- [ ] T020 [P] [US2] Integration test for SSR locale resolution in `app/tests/integration/ssr-locale.test.ts` — Cookie `fumireply_locale=en` を付けて inbox / threads を SSR レンダリング → HTML 内に英訳文字列を含む。Cookie なしは ja デフォルト

### Translation keys (parallel — different scope per file but same JSON file 2 つを編集するため逐次)

<!-- unit: U3.2 | deps: U2.1 | scope: frontend | tasks: T021-T024 | files: ~2 | automation: auto -->
- [ ] T021 [US2] Add login-screen keys (`login_email_label`, `login_password_label`, `login_submit_button`, `login_error_invalid_credentials`) to both `app/messages/en.json` and `app/messages/ja.json` — per contracts/locale-fn.md §4 example
- [ ] T022 [US2] Add inbox keys (`inbox_filter_all`, `inbox_filter_unread`, `inbox_filter_draft`, `inbox_filter_overdue`, `inbox_empty_state`) to both `app/messages/en.json` and `app/messages/ja.json`
- [ ] T023 [US2] Add thread + reply form keys (`thread_window_within_24h`, `thread_window_outside_24h`, `reply_placeholder`, `reply_send_button`, `reply_sending_button`, `reply_ai_suggestion_label`, `reply_draft_saved`, `reply_window_closed_warning`, `reply_policy_countdown`, `reply_error_outside_window`, `reply_error_token_expired`, `reply_error_meta_failed`, `reply_error_generic`) to both message files
- [ ] T024 [US2] Run `npx paraglide-js compile` and commit only the JSON files (not the generated TS) — confirm no compile error

### LanguageToggle component

<!-- unit: U3.3 | deps: U2.1,U3.2 | scope: frontend | tasks: T025-T027 | files: ~3 | automation: auto -->
- [ ] T025 [P] [US2] Implement `LanguageToggle` component in `app/src/routes/(app)/-components/LanguageToggle.tsx` — `EN | JA` text toggle, optimistic update via Paraglide `setLocale`, async call to `setLocaleFn`, aria-pressed for active state (per contracts/locale-fn.md §3)
- [ ] T026 [US2] Insert `LanguageToggle` into `(app)/route.tsx` Header — right side near user menu, no layout shift (depends on T025)
- [ ] T027 [US2] Insert `LanguageToggle` into `(auth)/login` screen — top-right absolute position so unauthenticated users can switch before logging in (depends on T025)

### Replace hardcoded JA strings with `m.xxx()` calls (parallel — separate component files)

<!-- unit: U3.4 | deps: U3.2 | scope: frontend | tasks: T028-T032 | files: ~5 | automation: auto -->
- [ ] T028 [P] [US2] Replace JA strings in `app/src/routes/(auth)/login/-components/LoginForm.tsx` with Paraglide message calls (T021 keys)
- [ ] T029 [P] [US2] Replace JA strings in `app/src/routes/(app)/inbox/-components/InboxList.tsx` with Paraglide message calls (T022 keys)
- [ ] T030 [P] [US2] Replace JA strings in `app/src/routes/(app)/threads/$id/-components/ThreadMessages.tsx` and thread header in `app/src/routes/(app)/threads/$id/index.tsx` (24h badge, header labels) with Paraglide calls (T023 keys)
- [ ] T031 [P] [US2] Replace JA strings in `app/src/routes/(app)/threads/$id/-components/ReplyForm.tsx` (placeholder, Send button, banners, error messages) with Paraglide calls (T023 keys)
- [ ] T032 [P] [US2] Replace JA strings in `app/src/routes/(app)/threads/$id/-components/DraftBanner.tsx` if any (e.g., "下書きを生成中…") with Paraglide calls — add new keys to T023 if needed and re-compile

### CI integration

<!-- unit: U3.5 | deps: U3.2 | scope: infra | tasks: T033 | files: ~1 | automation: auto -->
- [ ] T033 [US2] Add Paraglide compile diff check to `.github/workflows/ci.yml` — run `npx paraglide-js compile && git diff --exit-code messages/` to fail PR when JSON edits aren't compiled

### Manual verification

<!-- unit: U3.6 | deps: U3.3,U3.4 | scope: frontend | tasks: T034 | files: 0 | automation: manual -->
- [ ] T034 [US2] Manual test: Toggle EN → cycle through login / inbox / threads / reply form; assert zero remaining JA strings in screencast scope; toggle back to JA; restart browser; assert persistence

**Checkpoint**: US2 完結。screencast 範囲の全文字列が EN/JA で切替可能、Cookie 永続化、SSR で FOUC ゼロ。

---

## Phase 4: User Story 1 — Connect Facebook Page UI (Priority: P1) 🎯 MVP Core

**Goal**: ログイン後 connected_pages 未登録の operator を `/onboarding/connect-page` に強制誘導し、FB JS SDK で 4 権限同意 → ページ選択 → 長期 Page Access Token 取得 → 暗号化保存 → /inbox 着地、までを完結させる。

**Independent Test**: 撮影前 prep スクリプト（または `psql DELETE FROM connected_pages...`）で接続済み状態を解除 → ログイン → onboarding 画面 → FB Test User で Login → 4 権限同意 → Test Page 選択 → /inbox 到達、までを単独で再現できる。

### Tests for User Story 1

<!-- unit: U4.1 | deps: U2.2 | scope: backend | tasks: T035-T040 | files: ~6 | automation: auto -->
- [ ] T035 [P] [US1] Integration test for `exchangeAndListFn` in `app/tests/integration/exchange-and-list-fn.test.ts` using MSW (T017 handlers): happy path / token_expired (190) / permission_missing (200) / no_pages (empty data) / rate_limited (4) variants
- [ ] T036 [P] [US1] Integration test for `connectPageFn` in `app/tests/integration/connect-page-fn.test.ts` using MSW: happy path UPSERT verifies DB row, already_connected returns error without DB write, subscribe_failed returns error without DB write, encryption round-trip via decrypt
- [ ] T037 [P] [US1] Integration test for forward guard in `app/tests/integration/onboarding-guard.test.ts` — request `/inbox` with empty connected_pages returns 302 to `/onboarding/connect-page`; with a row present returns inbox HTML
- [ ] T038 [P] [US1] Integration test for reverse guard — request `/onboarding/connect-page` with a connected_pages row returns 302 to `/inbox`
- [ ] T039 [P] [US1] Cross-tenant safety test — tenant A's JWT calling connectPageFn with tenant_id field in input forged or attempting to write tenant B's row is blocked by RLS (within `withTenant` wrapper)
- [ ] T040 [US1] E2E test in `app/tests/e2e/connect-page-flow.spec.ts` using Playwright + FB Test User — full flow: login → onboarding → FB.login popup → page selection → /inbox; gated behind `FB_TEST_USER_EMAIL` env var

### Onboarding-screen translation keys

<!-- unit: U4.2 | deps: U3.2 | scope: frontend | tasks: T041 | files: ~2 | automation: auto -->
- [ ] T041 [US1] Add onboarding keys (`onboarding_title`, `onboarding_description`, `onboarding_connect_button`, `onboarding_consent_denied`, `onboarding_select_page_heading`, `onboarding_connecting`, `onboarding_no_pages`, `onboarding_error_token_expired`, `onboarding_error_permission_missing`, `onboarding_error_subscribe_failed`, `onboarding_error_generic`, `onboarding_retry_button`) to both `app/messages/en.json` and `app/messages/ja.json` and re-compile

### Server functions

<!-- unit: U4.3 | deps: U2.2 | scope: backend | tasks: T042-T043 | files: ~2 | automation: auto -->
- [ ] T042 [US1] Implement `exchangeAndListFn` in `app/src/routes/(app)/onboarding/connect-page/-lib/exchange-and-list.fn.ts` — Zod input/output per contracts/connect-page-fn.md §1, calls T015 wrapper functions, structured logging per facebook-graph.md
- [ ] T043 [US1] Implement `connectPageFn` in `app/src/routes/(app)/onboarding/connect-page/-lib/connect-page.fn.ts` — Zod input/output per contracts/connect-page-fn.md §2, performs subscribe → encrypt (existing `crypto.ts`) → UPSERT within `withTenant`, full error mapping including `already_connected`

### UI components

<!-- unit: U4.4 | deps: U2.2,U4.2 | scope: frontend | tasks: T044-T046 | files: ~3 | automation: auto -->
- [ ] T044 [P] [US1] Implement `ConnectFacebookButton` in `app/src/routes/(app)/onboarding/connect-page/-components/ConnectFacebookButton.tsx` — uses T014 SDK loader, calls `FB.login` with the four permissions in one consent dialog (`auth_type: 'reauthenticate'` so reviewers see the dialog every time), invokes T042 server fn on success
- [ ] T045 [P] [US1] Implement `PageList` in `app/src/routes/(app)/onboarding/connect-page/-components/PageList.tsx` — displays pages from T042 response, single-select UI, calls T043 server fn on confirm, displays page name + page ID
- [ ] T046 [P] [US1] Implement `ConnectErrorPanel` in `app/src/routes/(app)/onboarding/connect-page/-components/ConnectErrorPanel.tsx` — displays mapped error messages from T042/T043 plus a Retry button that resets the flow

### Route + guards

<!-- unit: U4.5 | deps: U4.3,U4.4 | scope: frontend | tasks: T047-T049 | files: ~3 | automation: auto -->
- [ ] T047 [US1] Create `/onboarding/connect-page` route at `app/src/routes/(app)/onboarding/connect-page/index.tsx` — composes ConnectFacebookButton / PageList / ConnectErrorPanel; manages flow state (initial / consent_done / pages_loaded / connecting / error); reverse guard via `beforeLoad` redirecting to `/inbox` if already connected
- [ ] T048 [US1] Add forward guard to `app/src/routes/(app)/route.tsx` `beforeLoad` — calls T016 `checkConnectedPagesFn`, throws redirect to `/onboarding/connect-page` if count==0; do NOT trigger guard on `/onboarding/*` paths to avoid loop
- [ ] T049 [US1] Update `app/src/routes/(app)/-components/LanguageToggle.tsx` Header insertion to also render on `/onboarding/connect-page` (so reviewer can pick EN before connecting)

### Manual verification

<!-- unit: U4.6 | deps: U4.5 | scope: frontend | tasks: T050 | files: 0 | automation: manual -->
- [ ] T050 [US1] Manual test on dev: Delete connected_pages row → log in → confirm forward redirect to onboarding → click Connect → consent 4 permissions → select Test Page → verify connected_pages row UPSERTed with encrypted token (decrypt round-trip via Drizzle Studio) → /inbox renders → send Messenger message from Test User → verify webhook receives + AI draft generated (existing 001 pipeline)

**Checkpoint**: US1 完結。Operator が UI 経由で Page を接続できる。screencast の主要シーンが録画可能な状態。

---

## Phase 5: User Story 3 — Submission documentation (Priority: P1)

**Goal**: `docs/review-submission/` 配下の 3 ファイルを Connect Page フロー追加 + EN UI 前提 + screencast タイムスタンプ参照込みで最終化する。

**Independent Test**: 各ドキュメントを開いて、Meta App Dashboard の各権限欄に貼り付ける本文・reviewer 認証情報・screencast シーン構成が破綻なく揃っていることを目視確認。プレースホルダー残存ゼロ・URL すべて 200 を `grep` と `curl` で確認できる。

<!-- unit: U5.1 | deps: U3.6,U4.6 | scope: docs | tasks: T051-T053 | files: ~3 | automation: manual -->
- [ ] T051 [US3] Update `docs/review-submission/use-case-description.md` — add Connect Page flow section, add per-permission timestamp references (e.g., "0:50–1:30 in screencast"), refresh sample text for `pages_show_list`/`pages_manage_metadata`/`pages_read_engagement`/`pages_messaging`, ensure all URLs use `review.fumireply.ecsuite.work`, English body
- [ ] T052 [P] [US3] Update `docs/review-submission/screencast-script.md` — rewrite all scenes assuming English UI (drop translation captions), insert new "Connect Facebook Page" scene (~40s) covering FB.login popup + page list + selection, add explicit timestamp markers per scene to align with use-case-description.md
- [ ] T053 [P] [US3] Update `docs/review-submission/reviewer-credentials.md` — replace legacy "Page is pre-connected via DB seed" wording with "Reviewer connects Test Page during the demo flow"; preserve SSM password retrieval section (operator-facing JA) and finalize the English submission-form-ready block

<!-- unit: U5.2 | deps: U5.1,U8.2 | scope: docs | tasks: T054-T055 | files: 0 | automation: auto -->
- [ ] T054 [US3] Verify zero placeholder leftovers: `grep -rn "<<.*>>" docs/review-submission/` returns no matches (depends on T051+T052+T053)
- [ ] T055 [US3] Verify URLs return 200: shell loop curling `https://review.fumireply.ecsuite.work` + `/privacy` + `/terms` + `/data-deletion` + `/login` + `/onboarding/connect-page` (after deploy of US1)

**Checkpoint**: 申請フォーム貼り付け用の最終本文が全 4 権限分揃った状態。

---

## Phase 6: User Story 4 — Submission walkthrough (Priority: P2)

**Goal**: Meta App Dashboard 上で「権限欄に何を貼るか／screencast をどこにアップロードするか／reviewer 認証情報をどこに記入するか／提出ボタン押下までの最終チェック」を順番に実行可能なガイドを作成する。

**Independent Test**: 申請担当でない第三者が `submission-walkthrough.md` だけ読んで、別のテスト用 Meta App（実提出はしない）に対して全項目を完走できる。

<!-- unit: U6.1 | deps: U5.1 | scope: docs | tasks: T056-T057 | files: ~2 | automation: auto -->
- [ ] T056 [US4] Create `docs/review-submission/submission-walkthrough.md` — sections: (1) Pre-submit prerequisites, (2) Meta App Dashboard navigation map, (3) Per-permission paste content table, (4) Screencast upload procedure (same MP4 to all 4 fields or single URL referenced 4 times), (5) Reviewer credentials placement, (6) Pre-submit checklist (≥10 items including Business Verification, public pages 200, Webhook green check, reviewer enabled, long-lived token, Anthropic disclosure, Supabase keep-alive), (7) Submit button click + capture submission ID, (8) Post-submit handoff referencing `docs/operations/audit-runbook.md`
- [ ] T057 [US4] Cross-link the walkthrough from `quickstart.md` §10 and from `docs/review-submission/reviewer-credentials.md` final-check section

<!-- unit: U6.2 | deps: U6.1 | scope: docs | tasks: T058 | files: 0 | automation: manual -->
- [ ] T058 [US4] **(Manual)** Internal review: have a teammate unfamiliar with Meta App Dashboard read T056 and walk through the form on a test Meta App (no actual submission); collect feedback and iterate

**Checkpoint**: US4 完結。属人性なく提出フォームに到達できる。

---

## Phase 7: User Story 5 — Recording prep automation (Priority: P3)

**Goal**: screencast 撮影前後の本番状態調整（reviewer 有効化、connected_pages クリア、ヘルスチェック、reviewer 無効化、cleanup）を bash スクリプトで自動化する。

**Independent Test**: `bash scripts/prep-screencast.sh --dry-run` で副作用なしの計画出力が確認できる。本番モード実行後、Supabase ダッシュボードで reviewer の `banned_until` が NULL、`connected_pages` の Malbek 行が空、を目視確認できる。

<!-- unit: U7.1 | deps: none | scope: infra | tasks: T059-T060 | files: ~2 | automation: auto -->
- [ ] T059 [P] [US5] Create `scripts/prep-screencast.sh` — `set -euo pipefail`, supports `--dry-run`, requires `AWS_PROFILE` env, reads SSM `/fumireply/review/supabase/{url,secret-key,reviewer-password,db-url}` and `/fumireply/master-encryption-key`, performs (a) reviewer `banned_until=NULL` via Supabase Admin API, (b) DELETE FROM connected_pages WHERE tenant_id matches Malbek slug, (c) macOS `pbcopy` of password, (d) curl 200 health check on production URLs, (e) append audit row to `docs/operations/audit-runbook.md`
- [ ] T060 [P] [US5] Create `scripts/post-screencast.sh` — sets reviewer `banned_until` to a future date (default 2099-12-31), supports `--rotate-password` flag to regenerate + SSM update, supports `--cleanup-recording-data` flag to DELETE the just-connected page + its conversations/messages, append audit row

<!-- unit: U7.2 | deps: U7.1 | scope: infra | tasks: T061-T062 | files: ~1 | automation: auto -->
- [ ] T061 [US5] Add `chmod +x` and an idempotent execution test in `scripts/test-prep.sh` (or document in `docs/operations/audit-runbook.md`) that `--dry-run` is safe to run anywhere
- [ ] T062 [US5] Document the scripts in `quickstart.md` §6 (already referenced) — confirm exact command names match T059/T060

**Checkpoint**: US5 完結。撮影者は 2 コマンドで前後状態を整えられる。

---

## Phase 8: Polish, Deploy, Submit

**Purpose**: 全 Story 完了後の本番反映、screencast 撮影、申請フォーム提出までを順次実行する。本フェーズは User Story 範囲外（運用フェーズ）だが、提出完了が SC-001/SC-002/SC-006 達成の必須条件のため tasks.md に含める。

### Pre-deploy verification

<!-- unit: U8.1 | deps: U3.6,U4.6,U5.1,U6.1,U7.2 | scope: backend | tasks: T063-T066 | files: 0 | automation: auto -->
- [ ] T063 [P] Run full vitest suite locally: `cd app && npm test` — all unit/integration tests pass
- [ ] T064 [P] Run Playwright E2E with FB Test User: `cd app && FB_TEST_USER_EMAIL=... npm run test:e2e -- connect-page-flow.spec.ts`
- [ ] T065 Verify CI pipeline passes on the 002 PR: lint + tsc + vitest + Paraglide compile diff + Terraform plan diff zero
- [ ] T066 Re-run plan's Constitution Check (plan.md §Constitution Check) — confirm Phase 1 ratings still hold post-implementation

### Deploy

<!-- unit: U8.2 | deps: U8.1 | scope: infra | tasks: T067-T068 | files: 0 | automation: manual -->
- [ ] T067 Deploy to production via existing pipeline: `npm run build --prefix app && npm run deploy:review` — should produce no Terraform diff (plan.md Performance Goals + R-014)
- [ ] T068 Production smoke after deploy: log in as reviewer (after T069 enables account), confirm `/onboarding/connect-page` reachable and previous `connected_pages` row still exists (not yet cleared)

### Recording prep + capture

<!-- unit: U8.3 | deps: U7.1,U8.2 | scope: docs | tasks: T069-T072 | files: 0 | automation: manual -->
- [ ] T069 Run `bash scripts/prep-screencast.sh` against production — reviewer enabled, connected_pages cleared, password to clipboard, health checks 200
- [ ] T070 **(Manual)** Record screencast per `docs/review-submission/screencast-script.md` — macOS QuickTime, 1080p, English UI, full flow logout → login → onboarding → Connect → AI draft → send → public pages
- [ ] T071 **(Manual)** Edit screencast in CapCut/iMovie — minimal annotations only (permission name overlays per scene, "Human clicks Send" emphasis), MP4 export ≤100MB ≤4 minutes
- [ ] T072 **(Manual)** Upload screencast to YouTube as Unlisted, copy URL into a temporary note for T076 reference

### Final pre-submit checks

<!-- unit: U8.4 | deps: U8.3,U5.2 | scope: infra | tasks: T073-T075 | files: 0 | automation: manual -->
- [ ] T073 Re-run T055 URL 200 checks (in case anything changed during deploy)
- [ ] T074 Verify Webhook subscription still green in Meta App Dashboard → Webhooks
- [ ] T075 Confirm reviewer credentials in `docs/review-submission/reviewer-credentials.md` match the SSM-current password (ran T069 already)

### Submit

<!-- unit: U8.5 | deps: U8.4,U6.2 | scope: docs | tasks: T076-T077 | files: ~1 | automation: manual -->
- [ ] T076 **(Manual)** Follow `docs/review-submission/submission-walkthrough.md` step-by-step in Meta App Dashboard — paste use-case bodies (4 permissions), upload/reference screencast (4 fields), enter reviewer credentials, complete pre-submit checklist, click Submit, capture submission ID
- [ ] T077 **(Manual)** Record submission ID + timestamp in `docs/operations/audit-runbook.md`

### Post-submit handoff

<!-- unit: U8.6 | deps: U8.5 | scope: infra | tasks: T078-T080 | files: ~1 | automation: manual -->
- [ ] T078 Run `bash scripts/post-screencast.sh` — re-disable reviewer, optionally rotate password (recommended after submission ID captured)
- [ ] T079 Update CloudWatch alarm subscription to confirm operator email + Slack webhook still receiving (existing 001 alarms)
- [ ] T080 Document expected review timeline (typically 5–10 business days) and rollback plan in `docs/operations/audit-runbook.md`

**Checkpoint**: 申請完了。承認待ち状態。

---

## Dependencies

### Phase ordering

```
Phase 1 (Setup)
   ↓
Phase 2 (Foundational)
   ↓
   ├─ Phase 3 (US2 — i18n)  ─┐
   │                          ├─→ Phase 4 (US1 — Connect Page) ─→ Phase 5 (US3 — docs)
   └──────────────────────────┘                                            ↓
                                                                  Phase 6 (US4 — walkthrough)
                                                                            ↓
                                                                  Phase 7 (US5 — scripts)
                                                                            ↓
                                                                  Phase 8 (Deploy + Submit)
```

### Inter-task dependencies (key ones)

- T010 → T011 → T012（locale 基盤の縦依存）
- T013 → T025（setLocaleFn が LanguageToggle のクリックハンドラから呼ばれる）
- T015 → T042 + T043（Graph API ラッパーが server fn から呼ばれる）
- T016 → T037 + T038 + T048（checkConnectedPagesFn が両 guard から呼ばれる）
- T021〜T023 → T028〜T031（メッセージキーが先、UI 置換が後）
- T024 → T028〜T031（Paraglide compile 後でないと `m.xxx()` がインポートできない）
- T041 → T044〜T047（onboarding キー追加 → UI 実装）
- T042 + T043 → T044 + T045（server fn が UI から呼ばれる）
- T044 + T045 + T046 → T047（部品が揃ってからルート組み立て）
- T048 → T050（forward guard が動作確認の前提）
- US1 + US2 完了 → Phase 5（docs に実装内容を反映）
- Phase 5 完了 → Phase 6（walkthrough は use-case-description を参照）
- Phase 7 → Phase 8（prep スクリプトが撮影前提）

### Story isolation

- US3 は US1 + US2 の実装 UI を観察してから書く方が事故が少ないため、Phase 5 を US1/US2 完了後に置いた。ただし下書き（暫定値で書き、後で具体値に置換）は Phase 3〜4 と並行可能。
- US5 は単独で着手可能だが、Phase 7 配置にしたのは「撮影 = 提出直前」のためまとめて運用する設計。

---

## Parallel Execution Examples

### Within Phase 1 (Setup)

T002, T003, T004, T007, T008, T009 は別ファイル / 別作業のため並列可。T005 は T002 + T003 + T004 完了後でないと意味がない。

### Within Phase 2 (Foundational)

T014, T015, T016, T017 は互いに独立（別ファイル、別関心事）→ 4 並列可。
T010 → T011 → T012 → T013 は連鎖（同じ i18n インフラのレイヤ依存）。

### Within Phase 3 (US2)

メッセージキー追加（T021〜T023）は同じ JSON ファイルを編集するため逐次。UI 置換（T028〜T031）は別コンポーネントなので並列可。テスト（T018〜T020）は実装と独立に並列可。

### Within Phase 4 (US1)

Server fn（T042, T043）と UI 部品（T044, T045, T046）は別ファイルだが**論理的依存**あり（UI が server fn を呼ぶ）→ T042/T043 を先に。テスト（T035〜T039）は MSW + DB モックで実装と独立並列可。E2E（T040）は Phase 4 完了後。

### Within Phase 5 (US3)

T051 と T052/T053 は別ファイルで内容も独立 → 並列可。T054 + T055 は全部完了後の検証。

### Within Phase 7 (US5)

T059 と T060 は別ファイル → 並列可。

---

## Implementation Strategy

### Recommended path (single dev, 約 4 日)

1. **Day 0 (0.5d)**: Phase 1 + Phase 2（基盤整備）。T001〜T017 を一気に通す。
2. **Day 1 (1d)**: Phase 3（US2）。screencast 範囲の文字列を全洗い出し → 翻訳 → UI 置換。Header に LanguageToggle 配置で動作確認。
3. **Day 2 (1d)**: Phase 4（US1）。Server fn → UI 部品 → ルート → guards の順で組み立て。手動 + integration テストで確認。
4. **Day 3 (1d)**: Phase 5 + Phase 6（docs 整備）。実装を見ながら use-case / screencast / reviewer creds を最終化、submission-walkthrough を新規作成。
5. **Day 4 (0.5d)**: Phase 7 + Phase 8 開始。撮影スクリプト → 撮影 → アップロード。
6. **Submission day (separate)**: Phase 8 後半（T076 提出 + T077〜T080 後処理）。

### Parallelization with multiple devs (2 devs想定の Day 1〜2 短縮)

- Dev A: Phase 3（US2）担当
- Dev B: Phase 2 後半（T014〜T017）+ Phase 4（US1）の server fn（T042, T043）を先行

→ Day 1 終了時点で US2 完結 + US1 server fn 完成、Day 2 で UI 統合 + テスト → Day 2 終了で US1 完結。Day 3 で docs、Day 4 で submission。

### MVP Path (Story 1 + Story 2 まで実装すれば最低限の screencast 撮影が可能)

Phase 1 → Phase 2 → Phase 3 → Phase 4 までで「動く UI の screencast 撮影」が可能になる。Phase 5〜6 のドキュメントが未完だと提出フォームには貼れないが、MVP 検証としては Phase 4 終了が一里塚。

### Blockers to watch

- **FB Test User の Page 作成**（T009）: Meta 側の自動化制約で手動作業必須。Phase 1 で確実に終わらせること。
- **Paraglide compile の生成物**（T006, T024）: `.gitignore` 漏れで生成物がコミットされると CI が壊れる可能性。
- **Webhook subscription 検証失敗**（T043 → FB error 803）: 本番 Webhook URL が応答していない時に発生。Phase 8 deploy 前に既存 Webhook Lambda の動作を再確認すること。

---

## Validation Checklist

- [x] Every task starts with `- [ ]` (markdown checkbox)
- [x] Every task has a sequential ID (T001〜T080)
- [x] [P] is used only when truly parallel (different files, no incomplete dependencies)
- [x] [Story] labels (US1〜US5) are present on all Phase 3〜7 tasks; absent on Setup/Foundational/Polish
- [x] Every task includes a concrete file path or "(Manual)" marker for non-code work
- [x] Each user story is independently testable per spec.md Independent Test criteria
- [x] Phase 1 (Setup) has no story labels
- [x] Phase 2 (Foundational) has no story labels
- [x] Final phase (Polish/Submit) has no story labels
