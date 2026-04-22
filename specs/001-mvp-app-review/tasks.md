---
description: "Tasks for MVP Meta App Review submission — Sprint 1〜6"
---

# Tasks: MVP for Meta App Review Submission

**Input**: Design documents from `/specs/001-mvp-app-review/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, infrastructure.md
**Scope**: Sprint 1〜6（Meta App Review 提出まで）。Phase 2+（AI 分類 Lambda, SQS, Instagram DM, Slack 通知, 顧客/商品管理）は含まない（spec.md §Out of Scope）。
**Tests**: 含む（spec.md / plan.md / contracts/ のテスト項目が明示的）

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 異なるファイル・依存なしで並行実行可能
- **[Story]**: US1〜US5（spec.md の User Story 番号）
- 各タスクに絶対に近い相対パスを明記

## Path Conventions

- アプリ: `app/src/`（ルート単位コロケーション + TanStack 公式 `src/test/routes/` ミラー構造）
- Terraform: `terraform/modules/`, `terraform/envs/review/`
- CI: `.github/workflows/`
- ドキュメント: `docs/review-submission/`, `docs/operations/`

---

## Phase 1: Setup — Walking Skeleton (Sprint 1)

**Purpose**: TanStack Start の scaffolding、TanStack Intent 導入、CI 稼働、Hello World 1 件通過

- [x] T001 Create `app/` directory and initialize npm project: `cd app && npm init -y`; edit `app/package.json` to set `"name": "fumireply-app"`, `"engines": { "node": ">=20.0.0" }`, and commit the generated `app/package-lock.json` (pnpm/yarn 禁止 per plan.md)
- [x] T002 Install TanStack Start runtime in `app/`: `@tanstack/react-start`, `@tanstack/react-router`, `react`, `react-dom`, `vinxi` (TanStack Start の bundler)
- [x] T003 [P] Install TanStack Router Vite plugin: `@tanstack/router-plugin` into `app/package.json` devDependencies
- [x] T004 Create `app/vite.config.ts` wiring `@tanstack/router-plugin/vite` (auto route tree generation) + `@vitejs/plugin-react`
- [x] T005 Create `app/tsconfig.json` with `strict: true`, `moduleResolution: "bundler"`, path alias `"~/*": ["./src/*"]`
- [x] T006 Create `app/src/routes/__root.tsx` minimal root layout (HTML shell, `<Outlet />`)
- [x] T007 **Run TanStack Intent setup**: `npx @tanstack/intent@latest install` from repository root; accept default target `CLAUDE.md`; verify `intent-skills` block is added so subsequent tasks auto-load `@tanstack/react-router` / `@tanstack/react-start` SKILL.md entries from `node_modules/`
- [x] T008 [P] Create `app/tsr.config.json` documenting `routeFileIgnorePrefix: "-"` (既定値を明示): `{ "routesDirectory": "./src/routes", "generatedRouteTree": "./src/routeTree.gen.ts", "routeFileIgnorePrefix": "-" }`
- [x] T009 [P] Install testing deps in `app/`: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`, `msw`, `@vitest/coverage-v8`
- [x] T010 [P] Create `app/vitest.config.ts` with `environment: "jsdom"`, `setupFiles: ["./src/test/setup.ts"]`, `include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"]`
- [x] T011 [P] Create `app/src/test/setup.ts` — `@testing-library/jest-dom` import + MSW server lifecycle hooks (空で可、Phase 3 で handler 追加)
- [x] T012 [P] Create `app/src/test/file-route-utils.tsx` — TanStack 公式ガイド準拠の `createTestRouter` ヘルパー（memory history + 指定ルートを mount する renderWithRouter 関数）
- [x] T013 [P] Install lint/format deps in `app/`: `eslint`, `prettier`, `typescript-eslint`, `eslint-config-prettier`
- [x] T014 [P] Create `app/.eslintrc.cjs` + `app/.prettierrc` (TanStack 系の無難な設定: 2 spaces, single quotes, trailing commas)
- [x] T015 [P] Add scripts to `app/package.json`: `"dev": "vinxi dev"`, `"build": "vinxi build"`, `"start": "vinxi start"`, `"test": "vitest run"`, `"typecheck": "tsc -b"`, `"lint": "eslint src/ tests/"`
- [x] T016 Create `app/src/routes/(public)/index.tsx` — "Hello World" 仮ページ（US3 で本番の会社情報ページに置換）
- [x] T017 [P] Create `app/src/test/routes/(public)/index.test.tsx` — smoke test: renderWithRouter `/` → "Hello World" が見える（TanStack 公式ガイドのミラー配置）
- [x] T018 Create `.github/workflows/ci.yml` — trigger on PR: checkout → `actions/setup-node@v4` (node 20) → `npm ci --prefix app` → `npm run typecheck --prefix app` → `npm run lint --prefix app` → `npm run test --prefix app` → `npm run build --prefix app`
- [x] T019 [P] Create `terraform/bootstrap/main.tf` — S3 bucket `malbek-terraform-state` (versioning, KMS encryption, public access block), DynamoDB `malbek-terraform-locks`, KMS alias `alias/terraform-state`; local state で一度だけ apply する想定（README コメント必須）
- [x] T020 [P] Create `terraform/bootstrap/outputs.tf` — 本編が参照するバケット名・テーブル名・KMS ARN を output
- [x] T021 [P] Create `.github/workflows/terraform-plan.yml` — trigger on PR touching `terraform/**`: `terraform fmt -check` + `validate` + `plan`、結果を PR コメント投稿（AWS OIDC role は Phase 2 T025 で接続）
- [x] T022 Create first PR with T001〜T021 の成果物、CI の `ci.yml` と `terraform-plan.yml` が緑であることを確認（Walking Skeleton 完了基準）

**Checkpoint Sprint 1 終了**: `npm test` が 1 件通過、CI 全緑、TanStack Intent 経由で Router/Start SKILL が Claude に auto-load される状態

---

## Phase 2: Foundational — Infrastructure + DB + Core Services (Sprint 2)

**Purpose**: すべての User Story が依存する基盤。ここが完了するまで US 実装に入らない。

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Terraform modules（各モジュール並行可）

- [ ] T023 [P] Create `terraform/modules/networking/` — VPC (10.0.0.0/16), 2 private subnets + 2 public subnets (ap-northeast-1a/c), NAT Gateway, VPC Endpoints (SSM, Secrets Manager, CloudWatch Logs), Security Groups (lambda_sg, rds_sg)
- [ ] T024 [P] Create `terraform/modules/database/` — RDS Postgres 15 `db.t4g.micro` in private subnets, rds_sg allow 5432 from lambda_sg only, parameter group, automated backups (7 日), storage encryption, no public IP
- [ ] T025 [P] Create `terraform/modules/auth/` — Cognito User Pool (password policy, auto_verified_attributes: email), App Client (USER_PASSWORD_AUTH enabled, no client secret), Groups `operators` / `reviewers`, Users `operator@malbek.co.jp` / `reviewer@malbek.co.jp` with initial passwords from SSM SecureString parameters
- [ ] T026 [P] Create `terraform/modules/secrets/` — SSM Parameter Store SecureString definitions: `/fumireply/review/meta/page-access-token`, `/fumireply/review/meta/webhook-verify-token`, `/fumireply/review/meta/app-secret`, `/fumireply/review/deletion-log/hash-salt` (値は後から手動投入、Terraform は空の placeholder)
- [ ] T027 [P] Create `terraform/modules/app-lambda/` — Lambda function skeleton (handler TBD in T032), IAM role with policies (VPC access, RDS access, SSM Get, Cognito), API Gateway HTTP API with `$default` route → Lambda integration
- [ ] T028 [P] Create `terraform/modules/static-site/` — S3 bucket (private, OAC), CloudFront distribution with 2 origins (S3 / API Gateway), path pattern routing: `/api/*`, `/_serverFn/*`, `/inbox*`, `/threads/*` → **API Gateway**、`/`, `/login`, `/privacy`, `/terms`, `/data-deletion`, `/data-deletion-status/*`, `/assets/*` → **S3**（`/login` は CSR のため HTML shell + JS bundle を S3 から配信、loginFn は `/_serverFn/*` 経由で APIGW に到達、plan.md L46-54 のレンダリング表に準拠）; ACM certificate in us-east-1, Route53 A record for custom domain
- [ ] T029 [P] Create `terraform/modules/github-actions-oidc/` — IAM OIDC provider for GitHub, role with trust policy for `repo:<owner>/fumireply:*`, policies for `terraform plan/apply` and Lambda/S3/CloudFront deploy
- [ ] T030 [P] Create `terraform/modules/observability/` — CloudWatch alarms (Lambda errors > 1% for 5min, 5xx > 1, RDS CPU > 80%), SNS topic for email subscription
- [ ] T031 Create `terraform/envs/review/{main.tf,variables.tf,providers.tf,backend.tf}` — wire all modules; `backend.tf` points to S3 backend bucket from bootstrap
- [ ] T032 Bootstrap state backend: `cd terraform/bootstrap && terraform init && terraform apply` (local state, 一度だけ)
- [ ] T033 Apply review environment: `cd terraform/envs/review && terraform init && terraform plan && terraform apply`; record outputs (Lambda ARN, API GW URL, CloudFront domain, RDS endpoint, Cognito Pool ID / App Client ID) to `terraform/envs/review/terraform.tfstate` (remote)

### Database schema

- [ ] T034 [P] Install DB deps in `app/`: `drizzle-orm`, `postgres`, `drizzle-kit`, `zod`
- [ ] T035 Create `app/src/server/db/schema.ts` — 4 entities per `data-model.md`: `connectedPages`, `conversations`, `messages`, `deletionLog`; include all indexes (UNIQUE on `meta_message_id` where NOT NULL, composite `(page_id, last_message_at DESC)`, etc.)
- [ ] T036 [P] Create `app/src/server/db/client.ts` — `postgres()` connection pool (max=1 for Lambda-per-invoke pattern), `drizzle(sql)` exported as `db`
- [ ] T037 [P] Create `app/drizzle.config.ts` — `schema: "./src/server/db/schema.ts"`, `out: "./src/server/db/migrations"`, `dialect: "postgresql"`
- [ ] T038 Run `npx drizzle-kit generate` to produce `app/src/server/db/migrations/0001_init.sql`; PR レビューで SQL 目視確認
- [ ] T039 [P] Create `app/src/server/db/seed/review.ts` + `npm run db:seed:review` script — seed `connectedPages` with Meta テスト FB ページ placeholder (page_id/page_name は `.env` or SSM 経由で上書き可能に)
- [ ] T040 Apply migration to review RDS: `DATABASE_URL=... npx drizzle-kit migrate`; seed を実行して `connectedPages` 1 行が存在することを確認

### Core shared services（auth / token / messenger）

- [ ] T041 [P] Create `app/src/server/env.ts` — zod schema validating required env vars (`DATABASE_URL`, `COGNITO_USER_POOL_ID`, `COGNITO_APP_CLIENT_ID`, `META_APP_SECRET_SSM_KEY`, `META_PAGE_TOKEN_SSM_KEY`, `WEBHOOK_VERIFY_TOKEN_SSM_KEY`, `AWS_REGION`)
- [ ] T042 [P] Create `app/src/server/services/token.ts` — `getPageAccessToken()` using `@aws-sdk/client-ssm` `GetParameter` with `WithDecryption: true`; module-level 5 分 in-memory cache
- [ ] T043 [P] Create `app/src/server/services/token.test.ts` — mock SSM client: cache hit, cache miss, decryption; vitest 標準機能で mock
- [ ] T044 [P] Create `app/src/server/services/messenger.ts` — `sendMessengerReply({ recipientPsid, messageText })`: global `fetch` (axios 禁止 per memory), `AbortSignal.timeout(5000)`, 指数バックオフ (3 回, base 500ms) per `contracts/meta-send-api.md` §Retry Strategy; 返却型 `{ ok: true, messageId } | { ok: false, error: 'token_expired' | 'outside_window' | ... }`
- [ ] T045 [P] Create `app/src/server/services/messenger.test.ts` — MSW で Meta Send API モック: 成功、5xx リトライ、400 no retry、token 失効（190 エラーコード）判定、timeout
- [ ] T046 [P] Create `app/src/server/services/auth.ts` — `CognitoJwtVerifier.create({ userPoolId, tokenUse: "id", clientId })` singleton + `verifyIdToken(token)` + `refreshIdToken(refreshToken)` (Cognito `InitiateAuth` REFRESH_TOKEN_AUTH)
- [ ] T047 [P] Create `app/src/server/services/auth.test.ts` — unit: verify 成功、JwtExpiredError 時の refresh 成功 / 失敗分岐
- [ ] T048 Create `app/src/server/middleware/auth-middleware.ts` — serverFn middleware: read `id_token` cookie → `verifyIdToken` → on expired call `refreshIdToken` and reset cookie → on refresh fail redirect `/login?returnTo=...`; expose `{ user: { sub, email, groups } }`

**Checkpoint Phase 2 終了**: Terraform apply 成功、Cognito 初期ユーザー作成、DB マイグレーション済み、全共通 service のユニットテスト通過、User Story 実装が並行開始可能

---

## Phase 3: User Story 1 — Reviewer login + inbox (Priority: P1) 🎯 MVP Core

**Goal**: レビュワーがログインし、Webhook 経由で受信したメッセージが inbox に表示される (FR-001〜004, FR-009〜011, FR-017)

**Independent Test**: `reviewer@malbek.co.jp` でログイン → テスト FB アカウントから Messenger 送信 → 30 秒以内に inbox に表示

### Webhook（FR-001〜004, FR-017）

- [ ] T049 [P] [US1] Create `app/src/routes/api/webhook/-lib/signature.ts` — HMAC-SHA256 verification against `META_APP_SECRET`; compare `X-Hub-Signature-256` header with computed; timing-safe compare (`crypto.timingSafeEqual`)
- [ ] T050 [P] [US1] Create `app/src/routes/api/webhook/-lib/signature.test.ts` — valid, invalid, missing header, wrong prefix (`sha1=` vs `sha256=`)
- [ ] T051 [P] [US1] Create `app/src/routes/api/webhook/-lib/idempotency.ts` — `upsertConversationAndMessage({ pagePsid, customerPsid, metaMessageId, body, messageType, timestamp })`: upsert `conversations` + `INSERT ... ON CONFLICT (meta_message_id) DO NOTHING` on `messages`; transaction; return `{ inserted: boolean }`
- [ ] T052 [P] [US1] Create `app/src/routes/api/webhook/-lib/idempotency.test.ts` — first insert, duplicate メッセージ ID で skip, conversation upsert (existing / new)
- [ ] T053 [US1] Create `app/src/routes/api/webhook/index.ts` — HTTP route: GET (hub.mode=subscribe → verify_token 比較 → hub.challenge エコー) + POST (signature verify → zod で `{ object: 'page', entry: [{ messaging: [...] }] }` バリデーション → messaging[] を upsertConversationAndMessage で冪等挿入 → 200) per `contracts/meta-webhook.md`; 署名不一致は 401、検証失敗は 200 (Meta 再送ループ回避)
- [ ] T054 [US1] Create `app/src/test/routes/api/webhook/index.test.ts` — integration against test DB: 実 Meta ペイロード形で POST → signature 検証 → DB に insert 確認; GET challenge 検証

### Login（FR-009, FR-010, FR-011）

- [ ] T055 [P] [US1] Create `app/src/routes/(auth)/login/-lib/login.fn.ts` — `loginFn` serverFn using `createServerFn({ method: 'POST' })` + Cognito `InitiateAuthCommand` (USER_PASSWORD_AUTH) per `contracts/admin-api.md`; Cookie set (id_token / refresh_token, HttpOnly, Secure, SameSite=Lax); error mapping (`NotAuthorizedException` → `invalid_credentials`, 含む `TooManyFailedAttemptsException` → `too_many_attempts`, `NEW_PASSWORD_REQUIRED` challenge → session 文字列付き)
- [ ] T056 [P] [US1] Create `app/src/routes/(auth)/login/-components/LoginForm.tsx` — controlled form (email, password), submit invokes `loginFn`; 成功時 `/inbox` へ navigate、失敗時 error をユーザーフレンドリーに表示
- [ ] T057 [US1] Create `app/src/routes/(auth)/login/index.tsx` — `createFileRoute` with `ssr: false` (CSR); マウント `LoginForm`; `returnTo` クエリがあればログイン成功後にそこへ navigate
- [ ] T058 [US1] Create `app/src/test/routes/(auth)/login/index.test.tsx` — integration with MSW Cognito mock: 正常ログイン → Cookie set、invalid_credentials 表示、too_many_attempts 表示、new_password_required 遷移
- [ ] T059 [P] [US1] Create `app/src/server/fns/logout.fn.ts` — `logoutFn` serverFn: Cognito `GlobalSignOutCommand` + Cookie Max-Age=0（複数ルートから呼ばれる cross-cutting のため `server/fns/` 配置）
- [ ] T060 [P] [US1] Create `app/src/server/fns/logout.test.ts` — unit with mocked Cognito client

### Inbox（FR-002）

- [ ] T061 [US1] Create `app/src/routes/(app)/inbox/-lib/list-conversations.fn.ts` — `listConversationsFn` serverFn: auth middleware → query `conversations` order by `last_message_at DESC` + subquery/join latest message body (100 文字 preview) + `within_24h_window` calc
- [ ] T062 [P] [US1] Create `app/src/routes/(app)/inbox/-components/InboxList.tsx` — list UI 参考 `mock/inbox-screens.jsx`; **除外**: VIP タグ、AI 分類カテゴリ、顧客管理機能、優先度、購入履歴（spec.md L181-191 Assumptions 遵守）; 含む: 顧客名（PSID フォールバック）、最終メッセージ preview、unread バッジ、24h 窓ステータス
- [ ] T063 [US1] Create `app/src/routes/(app)/inbox/index.tsx` — SSR route with auth middleware (T048); loader calls `listConversationsFn`, renders `InboxList`
- [ ] T064 [P] [US1] Create `app/src/test/routes/(app)/inbox/index.test.tsx` — integration: fixture 3 conversations → 最新順、未ログインリダイレクト、unread バッジ表示

**Checkpoint US1**: Webhook → DB → inbox 表示のフルパス稼働、reviewer 資格情報でログイン可能

---

## Phase 4: User Story 2 — Send reply (Priority: P1) 🎯 MVP Core

**Goal**: スレッドを開いて返信送信、Messenger 側に到達 (FR-005〜008, FR-018)

**Independent Test**: inbox から会話クリック → 返信入力 → 送信成功 → テスト FB アカウントの Messenger で受信確認

- [ ] T065 [US2] Create `app/src/routes/(app)/threads/$id/-lib/get-conversation.fn.ts` — `getConversationFn` serverFn: auth → query `conversations` + `messages` (時系列昇順) → `UPDATE conversations SET unread_count = 0 WHERE id = $id`; return `{ conversation: {...}, messages: [...] }` per `contracts/admin-api.md`
- [ ] T066 [US2] Create `app/src/routes/(app)/threads/$id/-lib/send-reply.fn.ts` — `sendReplyFn` serverFn: auth (groups に operators/reviewers 要) → conversation fetch → 24h window check (超過なら `outside_window` 返却) → INSERT `messages` with `send_status='pending', sent_by_cognito_sub=JWT.sub` → `sendMessengerReply` (T044) → UPDATE send_status + meta_message_id / send_error; 5 秒以内に決着 (FR-006, SC-004)
- [ ] T067 [P] [US2] Create `app/src/test/routes/(app)/threads/$id/-lib/send-reply.fn.test.ts` — integration with MSW Send API mock: 成功、outside_window、token_expired、meta_error (5xx), validation_failed (空 body)
- [ ] T068 [P] [US2] Create `app/src/routes/(app)/threads/$id/-components/ThreadMessages.tsx` — 時系列メッセージ表示、direction で左右振り分け、`send_status` でアイコン (sent=✓, failed=!, pending=ローディング); sticker/image/other タイプは placeholder テキスト表示 (spec.md Edge Case 対応)
- [ ] T069 [P] [US2] Create `app/src/routes/(app)/threads/$id/-components/ReplyForm.tsx` — textarea + 送信ボタン; 送信中 disabled; 24h 窓残り時間を表示 (残り 0 の時は送信ボタン disabled + 説明テキスト); `sendReplyFn` のエラーを画面に表示 (FR-008)
- [ ] T070 [US2] Create `app/src/routes/(app)/threads/$id/index.tsx` — SSR route: loader で `getConversationFn`、`ThreadMessages` + `ReplyForm` をマウント
- [ ] T071 [P] [US2] Create `app/src/test/routes/(app)/threads/$id/index.test.tsx` — integration: メッセージ表示順、unread リセット確認、24h 超過で送信無効化、送信成功後に outbound メッセージがスレッドに追加表示

### FR-018 Page Access Token 警告

- [ ] T072 [P] [US2] Create `app/src/server/fns/page-status.fn.ts` — `getPageStatusFn` serverFn: Meta Graph API `GET /me?fields=id,name` via `fetch` with Page Access Token; 5 分サーバーキャッシュ; 401 応答なら `token_valid: false`
- [ ] T073 [P] [US2] Create `app/src/routes/(app)/-components/TokenStatusBanner.tsx` — 5 分ごとに `getPageStatusFn` ポーリング (useEffect + setInterval); `token_valid === false` で赤バナー "Page Access Token が失効しています。管理者に連絡してください。" 表示
- [ ] T074 [US2] Update `app/src/routes/(app)/__root.tsx` (または `(app)` layout ファイル) に `TokenStatusBanner` をマウント

### 統合テスト + E2E

- [ ] T075 [P] [US2] Create `app/tests/integration/send-reply.test.ts` — full flow against test DB + MSW Meta API: ログイン → inbox 取得 → threads/$id 取得 → sendReply → DB に outbound メッセージ `sent` で記録
- [ ] T076 [P] [US2] Create `app/tests/e2e/review-flow.spec.ts` — Playwright: ログイン → inbox → thread クリック → reply 入力 → 送信 → 成功メッセージ表示 (MSW または Playwright network interception で Send API モック)
- [ ] T077 [P] Create `.github/workflows/e2e.yml` — nightly trigger: build app → spin up postgres service container → `npm run test:e2e` against local preview

**Checkpoint US2**: 管理画面からの返信送信が Messenger 実機に到達 (テスト FB ページでの手動スモーク)

---

## Phase 5: User Story 3 — Public pages + data deletion (Priority: P1) 🎯 MVP Core

**Goal**: プライバシー / 利用規約 / データ削除 / 会社情報ページを独自ドメイン HTTPS 配信 (FR-011〜015)

**Independent Test**: 各 URL を外部ブラウザから直接開き、HTTPS 有効 + 必須記載事項（取得データ、保存期間、削除窓口、連絡先）を確認

- [ ] T078 [P] [US3] Create `app/src/routes/(public)/index.tsx` — 会社情報ページ: 法人名「Malbek」、住所、電話、事業内容; Business Verification 書類と一致させる (FR-015)
- [ ] T079 [P] [US3] Create `app/src/routes/(public)/privacy.tsx` — プライバシーポリシー: 取得項目 (Messenger メッセージ本文、PSID、ページ ID)、利用目的、保存期間 (メッセージ: 削除依頼まで、削除ログ: SHA-256 ハッシュ 3 年)、第三者提供なし、削除窓口 URL、連絡先メール (FR-012)
- [ ] T080 [P] [US3] Create `app/src/routes/(public)/terms.tsx` — 利用規約 (FR-013)
- [ ] T081 [P] [US3] Create `app/src/routes/(public)/data-deletion.tsx` — データ削除手順ページ: メールによる手動削除依頼 + Meta データ削除コールバックの動作説明 (FR-014)
- [ ] T082 [US3] Configure SSG prerender: update `app/vite.config.ts` / TanStack Start config to mark `(public)/*` routes as `prerender: true`; `npm run build` 成果物に 4 ページの静的 HTML が出力されること確認
- [ ] T083 [P] [US3] Create `app/src/routes/api/data-deletion/-lib/delete-user-data.ts` — transaction: fetch `conversations` where `customer_psid = $psid` → DELETE `messages` where `conversation_id IN (...)` → DELETE `conversations` → INSERT `deletion_log` with `psid_hash = sha256(salt || psid)` (salt は SSM から取得) + random `confirmation_code` UUID
- [ ] T084 [P] [US3] Create `app/src/routes/api/data-deletion/-lib/delete-user-data.test.ts` — integration: fixture PSID 削除 → messages/conversations 消える、deletion_log 行追加、confirmation_code 生成
- [ ] T085 [US3] Create `app/src/routes/api/data-deletion/index.ts` — POST handler per `contracts/data-deletion-callback.md`: Meta `signed_request` verify (HMAC-SHA256) → body から `user_id` (PSID) 抽出 → `delete-user-data` 実行 → `{ url: "https://<domain>/data-deletion-status/<code>", confirmation_code: "<code>" }` 返却
- [ ] T086 [P] [US3] Create `app/src/test/routes/api/data-deletion/index.test.ts` — integration: valid signed_request → 200 + JSON 返却、invalid signature → 401
- [ ] T087 [US3] Create `app/src/routes/(public)/data-deletion-status/$code.tsx` — SSR route: status URL; `deletion_log` から code で検索し「Deleted」or「Not found」のみ返す (個人情報含めない)
- [ ] T088 [US3] Update `terraform/modules/static-site/` CloudFront behaviors: `/`, `/login`, `/privacy`, `/terms`, `/data-deletion`, `/data-deletion-status/*`, `/assets/*` → **S3 origin**（login は CSR ビルド出力）; `/api/*`, `/_serverFn/*`, `/inbox*`, `/threads/*` → **API Gateway origin**; `terraform apply` で反映。plan.md L46-54 レンダリング表と一致させる（`/login` は S3 配信、loginFn 呼び出しは `_serverFn/*` 経由で APIGW へ）
- [ ] T089 Create `.github/workflows/deploy-app.yml` — on merge to main: `npm run build --prefix app` → upload to S3 via AWS CLI the **SSG output**（`(public)/*` の HTML）+ **CSR ビルド出力**（`(auth)/login` の HTML shell + JS bundle）+ 共通 assets → CloudFront invalidation (`/*`) → package Lambda zip（SSR ルートと server-only ルートのみ）→ `aws lambda update-function-code`

**Checkpoint US3**: 4 公開 URL が独自ドメイン HTTPS で配信、データ削除コールバックが signed_request を処理、CloudFront ルーティングが正

---

## Phase 6: User Story 4 — Screencast (Priority: P1) 🎯 MVP Core

**Goal**: 権限ごとの使用箇所を明示したスクリーンキャスト動画 (FR-019)

**Independent Test**: 動画を第三者に見せて「どの画面/操作/権限/価値か」が明示できているか確認

- [ ] T090 [P] [US4] Create `docs/review-submission/screencast-script.md` — 撮影台本: シーン 1 ログイン (`pages_messaging` 前提)、シーン 2 inbox (`pages_manage_metadata` + `pages_read_engagement`)、シーン 3 スレッド表示、シーン 4 返信送信 (`pages_messaging`)、各シーンで権限名を字幕表示するタイミングを明記; Meta 要件: 2 分目安, MP4
- [ ] T091 [P] [US4] Create `docs/review-submission/reviewer-credentials.md` — レビュワー用資格情報 (reviewer@malbek.co.jp / 初期パスワード) + テスト FB ページへのアクセス手順 (FR-010, FR-021) + 「24 時間以内に Messenger 送信してから返信テストしてください」の運用注意
- [ ] T092 [US4] Record screencast: review 環境に対し実動作でログイン→inbox→スレッド→reply 送信のフルパスを画面収録
- [ ] T093 [US4] Edit screencast: 字幕 / ナレーション 追加 (各シーンで使用する権限名を明示)、MP4 export、100MB 以下・2 分以内に収める

---

## Phase 7: User Story 5 — Use Case description (Priority: P2)

**Goal**: Phase 2 機能拡張が同一権限スコープで読み取れる Use Case 説明文 (FR-020, SC-007)

**Independent Test**: Use Case 説明文を第三者レビュー (Meta 申請代行情報 or コミュニティ) に照らし、Phase 2 機能 (AI 分類, 顧客管理, 商品管理, Slack 通知) が同一スコープとして読み取れるか確認

- [ ] T094 [P] [US5] Create `docs/review-submission/use-case-description.md` — 英語; `pages_messaging` / `pages_manage_metadata` / `pages_read_engagement` の各権限について、「how this app uses <permission>」「user-facing value」「referenced screens」に加え Phase 2 予定機能 (AI-assisted reply drafting, customer context for operators, product-aware response suggestions, team-wide notification via Slack) を "all within the same Messenger inbound/outbound scope" として含める
- [ ] T095 [US5] Third-party review of `use-case-description.md` (コミュニティ or 申請代行情報)、指摘を反映

---

## Phase 8: Polish & Submission Preparation — Sprint 5-6

**Purpose**: 審査提出直前の仕上げ。CloudWatch / deploy pipeline / ドキュメント / 最終リハーサル。

- [ ] T096 [P] Create `docs/operations/audit-runbook.md` — 審査期間中の監視手順: RDS 停止禁止、CloudWatch アラーム対応、deletion_log の 3 年超過分の手動 cleanup SQL、Page Access Token 延命手順、Cognito パスワードリセット
- [ ] T097 [P] Enable CloudWatch alarms in `terraform/envs/review/main.tf` — Lambda error rate, 5xx, RDS CPU, SNS email 購読、`terraform apply`
- [ ] T098 [P] Create `.github/workflows/terraform-apply.yml` — on merge to main, paths `terraform/**`: manual approval gate (environment=production) → `terraform apply` via OIDC role
- [ ] T099 [P] Update `contracts/admin-api.md` — serverFn パスを route-colocated 配置 (`app/src/routes/(auth)/login/-lib/login.fn.ts` 等) に同期、全 serverFn の file path を plan.md の構造と一致させる
- [ ] T106 [P] **Create test Facebook page** in Meta Business Manager: operator@malbek.co.jp がページ管理者権限を持つ新規 FB ページを作成、Messenger 受信を有効化、Meta App の Webhook を当該ページに購読、short-lived Page Access Token を取得 → `terraform/envs/review/terraform.tfvars` の `page_id` / `page_name` を実値に置換 → `npm run db:seed:review` 再実行で `connectedPages` 行を更新（FR-021、T100 の前提条件）
- [ ] T100 Verify Page Access Token は長期トークン化（**T106 完了後に実施**）: Meta Graph API `fb_exchange_token` で short-lived → long-lived → never-expiring Page Token に変換し SSM `/fumireply/review/meta/page-access-token` に格納; 手順を `audit-runbook.md` にも記録
- [ ] T101 Manual smoke test (FR-001〜008): テスト FB アカウントから Messenger 送信 → 30 秒以内に inbox 反映 (SC-003) → スレッド開く → reply 送信 → 5 秒以内に Messenger 受信 (SC-004); 失敗ケースも再現 (トークン失効、24h 超過)
- [ ] T107 [P] **Verify FR-017 Webhook 20-second SLA** via CloudWatch Logs Insights: query `fields @timestamp, @duration | filter @log like /webhook/ | stats pct(@duration, 95) as p95, pct(@duration, 99) as p99, max(@duration) as max` を直近 48 時間で実行、p95 < 5000ms / p99 < 15000ms / max < 20000ms を確認（plan.md L56-57 performance goals 準拠）。違反時は Phase 2 で同期 DB 挿入を SQS 経由の非同期化に移行する判断材料とする
- [ ] T108 [P] **Verify SC-002 login → inbox p95 < 10 seconds**: reviewer@malbek.co.jp で 5 回ログイン測定（Lambda cold start 直後 1 回 + warm 4 回）、ブラウザ DevTools Network タブで form submit から inbox 初期表示完了までのレイテンシを計測、全値と p95 を `docs/operations/audit-runbook.md` に記録。p95 が 10 秒を超える場合はプロビジョンドコンカレンシー導入の判断材料とする
- [ ] T102 Verify 公開 4 URL: `curl -I https://<domain>/`, `/privacy`, `/terms`, `/data-deletion`, `/data-deletion-status/test` がすべて HTTPS + 200 (SC-006)
- [ ] T103 Verify 24/7 稼働 (48 時間連続観測): CloudWatch で Lambda / RDS / CloudFront にエラーなく稼働、ダウンタイムなし (FR-016, SC-005)
- [ ] T104 Update `specs/001-mvp-app-review/quickstart.md` §6「審査提出前チェックリスト」 — 全項目をチェック済みに更新、未達項目があれば T096〜T103 / T106〜T108 にフィードバック
- [ ] T105 Submit Meta App Review: App Dashboard フォームで Webhook Callback URL (`https://<domain>/api/webhook`) + Privacy Policy URL + Terms URL + Data Deletion URL + 管理画面 URL + screencast (`docs/review-submission/`) + use case description (`docs/review-submission/use-case-description.md`) + reviewer credentials (`docs/review-submission/reviewer-credentials.md`) を全項目入力、`pages_messaging` / `pages_manage_metadata` / `pages_read_engagement` をリクエスト、submit

**Checkpoint 審査提出完了**: Meta 申請フォーム全項目入力済み、submit ボタン押下完了、申請 ID 取得

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: 依存なし、即時開始可。CI 緑が Phase 2 着手の前提
- **Phase 2 (Foundational)**: Phase 1 完了後。**すべての US をブロック**
- **Phase 3〜5 (US1, US2, US3)**: Phase 2 完了後、並列実行可 (スタッフング次第)
- **Phase 6 (US4 Screencast)**: US1 + US2 の実装完了 + デプロイ済みが前提 (実動作を収録するため)
- **Phase 7 (US5 Use Case)**: 並行可能だが第三者レビュー (T095) は US1〜US4 概ね完了後に実施
- **Phase 8 (Polish & Submission)**: US1〜US4 + 必要に応じ US5 完了後

### User Story Dependencies

- **US1 (Login + Inbox)**: Phase 2 完了で開始可、他 US への依存なし
- **US2 (Send Reply)**: Phase 2 完了で開始可だが Phase 3 T063 (inbox route) が存在すると E2E テスト (T076) が書きやすい → US1 の inbox route 作成後が現実的
- **US3 (Public Pages)**: Phase 2 完了で独立開始可、他 US と完全独立
- **US4 (Screencast)**: US1 + US2 実機動作が前提
- **US5 (Use Case)**: Phase 2 完了で独立開始可（ドキュメントのみ）

### Within Each User Story

- Tests (T050, T054, T058, T064, T067, T071, T075, T076, T084, T086) は実装前に書いて fail 確認
- `-lib/*.ts` (serverFn / core logic) → `-components/*.tsx` (UI) → `index.tsx` (route 組み立て) → `src/test/routes/**/index.test.tsx` (route-level integration)
- 各 User Story の checkpoint を通過してから次の US へ

---

## Parallel Opportunities

### Phase 1 Setup

```bash
# T003 + T009 + T013: 別パッケージの install、並行実行可
# T008 + T010 + T011 + T012: 別ファイルの設定、並行実行可
# T014 + T015: 別ファイル
# T017: smoke テスト、T016 の Hello World 実装と並行可
# T019 + T020 + T021: Terraform bootstrap + CI workflow、相互独立
```

### Phase 2 Foundational

```bash
# T023〜T030: Terraform 各モジュールは独立ファイル、並行実行可
# T034 + T036 + T037 + T041 + T042 + T044 + T046: app パッケージ install 後、別ファイル、並行可
# T043 + T045 + T047: 各サービスのテストは並行可
```

### Phase 3 US1

```bash
# Webhook サブツリー (T049〜T054) と Login サブツリー (T055〜T060) と Inbox サブツリー (T061〜T064) は独立、3 並列化可
# T050 (signature.test) + T052 (idempotency.test): -lib 内で別ファイル、並行可
# T056 (LoginForm) + T059 (logoutFn): 独立ファイル、並行可
```

### Phase 4 US2

```bash
# T068 (ThreadMessages) + T069 (ReplyForm) + T072 (getPageStatusFn) + T073 (TokenStatusBanner): 独立ファイル、4 並列可
# T075 + T076 + T077: 統合 / E2E / CI は各々独立
```

### Phase 5 US3

```bash
# T078〜T081: 4 公開ページは完全独立、4 並列可
# T083 (delete-user-data) + T084 (delete-user-data.test): -lib 内で別ファイル、並行可
```

---

## Implementation Strategy

### MVP Path (Meta 申請提出まで)

1. **Sprint 1 (Phase 1)**: Walking Skeleton、CI 緑、TanStack Intent セットアップ (T007)
2. **Sprint 2 (Phase 2)**: Infrastructure + DB + 共通サービス、この checkpoint は絶対死守
3. **Sprint 2〜3 (Phase 3 = US1)**: Webhook → DB → inbox 表示、reviewer ログイン可能 → 中間デモ可
4. **Sprint 3〜4 (Phase 4 = US2)**: 返信送信パス、Messenger 実機到達 → 申請スコープ網羅完了
5. **Sprint 2〜3 並行 (Phase 5 = US3)**: 公開ページ + データ削除 → 申請フォーム URL 入力可能
6. **Sprint 4〜5 (Phase 6 = US4)**: 動画撮影・編集
7. **Sprint 5 (Phase 7 = US5)**: Use Case 説明文
8. **Sprint 5〜6 (Phase 8)**: 仕上げ + 申請提出 (T105)

### Incremental Delivery Checkpoints

- 各 Phase の Checkpoint ごとに `quickstart.md` §6 チェックリストを部分的に埋める
- US1 完了時点で内部デモ可能 (review 環境に Webhook 到達 + inbox 表示)
- US2 完了時点で申請準備の大半が整う (screencast 収録材料が揃う)
- US3 完了時点で公開 URL が全部入る (申請フォームの必須 URL 4 本 + Webhook URL)
- Phase 8 で 48 時間稼働確認を終えて提出

### Sprint 対応表（plan.md §Sprint 計画と一致）

| Sprint | plan.md Tasks | 対応 tasks.md Phase |
|--------|---------------|---------------------|
| Sprint 1 | Walking Skeleton | Phase 1 (T001〜T022) |
| Sprint 2 | Infrastructure + 公開ページ + Cognito | Phase 2 (T023〜T048) + Phase 5 先行 (T078〜T081) |
| Sprint 3 | US1 + US2 着手 + E2E | Phase 3 (T049〜T064) + Phase 4 着手 (T065〜T071) |
| Sprint 4 | US2 完結 + screencast ドラフト | Phase 4 完結 (T072〜T077) + Phase 6 ドラフト (T090〜T091) |
| Sprint 5 | screencast 撮影 + Use Case + data deletion | Phase 5 完結 (T082〜T089) + Phase 6 (T092〜T093) + Phase 7 (T094〜T095) |
| Sprint 6 | 提出リハーサル | Phase 8 (T096〜T108、T105 が最終 submit) |

---

## Notes

- `[P]` は別ファイル・依存なしタスク。並列化のヒント。
- `[US1]〜[US5]` は spec.md の User Story に対応。
- 全タスクはコロケーション構造 (`routes/<path>/index.tsx` + `-components/` + `-lib/`) と TanStack 公式テストガイドの `src/test/routes/` ミラー配置に従う。
- **axios 禁止**：全外部 HTTP は `fetch` (CLAUDE.md 記載の memory 準拠)
- Phase 2+ 機能 (AI 分類, Slack, Instagram, 顧客/商品管理) は本 tasks.md の範囲外。審査通過後に別 feature branch で追加。
- 各タスク完了後に commit 推奨。大きな `-lib/` + `-components/` + `index.tsx` + test の 4 ファイルセットは 1 commit で纏めて可。
