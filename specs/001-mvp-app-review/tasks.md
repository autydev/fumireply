---
description: "Tasks for MVP Meta App Review submission — Sprint 1〜6（Supabase + AI 下書き構成）"
---

# Tasks: MVP for Meta App Review Submission

**Input**: Design documents from `/specs/001-mvp-app-review/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, infrastructure.md
**Updated**: 2026-04-30 (architecture pivot: Supabase + Anthropic API + AI 下書き Worker + **マルチテナント SaaS 前提（最初から組み込み）**、Cognito/RDS/VPC/NAT 廃止、Page Access Token は DB 暗号化カラムへ)
**Scope**: Sprint 1〜6（Meta App Review 提出まで）。Phase 2+（AI 自動分類, Instagram DM, Slack 通知, 顧客/商品管理）は含まない（spec.md §Out of Scope）。
**Tests**: 含む（spec.md / plan.md / contracts/ のテスト項目が明示的）

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 異なるファイル・依存なしで並行実行可能
- **[Story]**: US1〜US5（spec.md の User Story 番号）
- 各タスクに絶対に近い相対パスを明記

## Path Conventions

- アプリ: `app/src/`（ルート単位コロケーション + TanStack 公式 `src/test/routes/` ミラー構造）
- Webhook 受信 Lambda: `webhook/src/`
- AI 下書き Worker Lambda: `ai-worker/src/`
- keep-alive Lambda: `keep-alive/src/`
- Terraform: `terraform/modules/`, `terraform/envs/review/`
- CI: `.github/workflows/`
- ドキュメント: `docs/review-submission/`, `docs/operations/`

---

## Phase 1: Setup — Walking Skeleton (Sprint 1)

**Purpose**: TanStack Start の scaffolding、TanStack Intent 導入、CI 稼働、Hello World 1 件通過

- [x] T001 Create `app/` directory and initialize npm project: `cd app && npm init -y`; edit `app/package.json` to set `"name": "fumireply-app"`, `"engines": { "node": ">=24.0.0" }`, and commit the generated `app/package-lock.json` (pnpm/yarn 禁止 per plan.md)
- [x] T002 Install TanStack Start runtime in `app/`: `@tanstack/react-start`, `@tanstack/react-router`, `react`, `react-dom`, `vinxi` (TanStack Start の bundler)
- [x] T003 [P] Install TanStack Router Vite plugin: `@tanstack/router-plugin` into `app/package.json` devDependencies
- [x] T004 Create `app/vite.config.ts` wiring `@tanstack/router-plugin/vite` (auto route tree generation) + `@vitejs/plugin-react`
- [x] T005 Create `app/tsconfig.json` with `strict: true`, `moduleResolution: "bundler"`, path alias `"~/*": ["./src/*"]`
- [x] T006 Create `app/src/routes/__root.tsx` minimal root layout (HTML shell, `<Outlet />`)
- [x] T007 **Run TanStack Intent setup**: `npx @tanstack/intent@latest install` from repository root
- [x] T008 [P] Create `app/tsr.config.json` documenting `routeFileIgnorePrefix: "-"`
- [x] T009 [P] Install testing deps in `app/`: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`, `msw`, `@vitest/coverage-v8`
- [x] T010 [P] Create `app/vitest.config.ts`
- [x] T011 [P] Create `app/src/test/setup.ts`
- [x] T012 [P] Create `app/src/test/file-route-utils.tsx`
- [x] T013 [P] Install lint/format deps in `app/`
- [x] T014 [P] Create `app/.eslintrc.cjs` + `app/.prettierrc`
- [x] T015 [P] Add scripts to `app/package.json`
- [x] T016 Create `app/src/routes/(public)/index.tsx` — "Hello World" 仮ページ
- [x] T017 [P] Create `app/src/test/routes/(public)/index.test.tsx` — smoke test
- [x] T018 Create `.github/workflows/ci.yml`
- [x] T019 [P] Create `terraform/bootstrap/main.tf`
- [x] T020 [P] Create `terraform/bootstrap/outputs.tf`
- [x] T021 [P] Create `.github/workflows/terraform-plan.yml`
- [x] T022 First PR with T001〜T021、CI 緑

**Checkpoint Sprint 1 終了**: `npm test` が 1 件通過、CI 全緑、TanStack Intent 経由で Router/Start SKILL が Claude に auto-load される状態

---

## Phase 2: Foundational — Supabase + AWS インフラ + 共通サービス (Sprint 2)

**Purpose**: すべての User Story が依存する基盤。Supabase プロジェクト作成 + AWS リソース（VPC/RDS/Cognito 不使用）+ 共通サービス。

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Supabase + 外部サービスのセットアップ
<!-- unit: U2.1 | deps: none | scope: infra | tasks: T023,T024 | files: 0 | automation: manual -->

- [ ] T023 [P] **Create Supabase project** (Tokyo region, Free plan): プロジェクト URL、anon key、service role key、Pooler 接続文字列（Transaction mode、port 6543）を控える。`quickstart.md` §2.5 参照
- [ ] T024 [P] **Create Anthropic API account + key**: Anthropic Console で API キー発行、最低 $5 クレジット入金、`quickstart.md` §0 前提を満たす

### Terraform modules（各モジュール並行可、VPC/RDS/Cognito モジュールは廃止）
<!-- unit: U2.2 | deps: U2.1 | scope: infra | tasks: T025-T033 | files: ~9 | automation: auto -->

- [ ] T025 [P] Create `terraform/modules/secrets/` — SSM Parameter Store SecureString definitions per `infrastructure.md` §3.1: `/fumireply/review/meta/{webhook-verify-token,app-secret}`（**全テナント共通、page-access-token は DB 暗号化カラム化により廃止**）、`/fumireply/review/supabase/{url,anon-key,service-role-key,db-url}`、`/fumireply/review/anthropic/api-key`、`/fumireply/review/deletion-log/hash-salt`、**`/fumireply/master-encryption-key`**（マルチテナント用 AES-256 マスター鍵）。値は後から手動投入、Terraform は空 placeholder で `lifecycle.ignore_changes=[value]`
- [ ] T026 [P] Create `terraform/modules/queue/` — SQS Standard Queue `fumireply-review-ai-draft-queue`（Visibility Timeout 90 秒、long polling 20 秒）+ DLQ `fumireply-review-ai-draft-dlq`（Retention 14 日）+ Redrive Policy（`maxReceiveCount=3`）per `infrastructure.md` §3.2
- [ ] T027 [P] Create `terraform/modules/app-lambda/` — TanStack Start SSR Lambda（`nodejs24.x`、Memory 1024MB、Timeout 30 秒、**VPC 外**、Lambda Web Adapter Layer attach）+ IAM Role（SSM Get、CloudWatch Logs、**VPC 関連権限なし**）+ API Gateway HTTP API + `$default` route → Lambda integration、環境変数 `AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap`、`PORT=8080`、`SSM_PATH_PREFIX=/fumireply/review/`
- [ ] T028 [P] Create `terraform/modules/webhook-lambda/` — Webhook 受信 Lambda（`nodejs24.x`、Memory 512MB、Timeout 10 秒、VPC 外）+ IAM Role（SSM Get、SQS SendMessage 限定 ARN、CloudWatch Logs）+ API Gateway Route `GET/POST /api/webhook` → このLambda integration（`app-lambda` の API Gateway を共有）
- [ ] T029 [P] Create `terraform/modules/ai-worker-lambda/` — AI Worker Lambda（`nodejs24.x`、Memory 512MB、Timeout 60 秒、VPC 外）+ IAM Role（SSM Get、SQS Receive/Delete、CloudWatch Logs）+ SQS Event Source Mapping（Batch Size 1）+ 環境変数 `ANTHROPIC_MODEL=claude-haiku-4-5-20251001`
- [ ] T030 [P] Create `terraform/modules/keep-alive-lambda/` — keep-alive Lambda（`nodejs24.x`、Memory 256MB、Timeout 30 秒、VPC 外）+ IAM Role（SSM Get、CloudWatch Logs、SNS Publish）+ EventBridge Scheduled Rule **`rate(1 day)`** + Lambda Permission + Retry Policy（`maximum_retry_attempts=2`、`maximum_event_age_in_seconds=3600`）+ `dead_letter_config` を SNS Topic に設定 + `OnFailure` Destination を SNS Topic に設定 per `infrastructure.md` §3.6
- [ ] T031 [P] Create `terraform/modules/static-site/` — S3 bucket（private、OAC）+ CloudFront distribution with 2 origins（S3 / API Gateway）+ path pattern routing per `infrastructure.md` §3.7: `/api/*`、`/_serverFn/*`、`/inbox*`、`/threads/*` → **API Gateway**；それ以外（`/`、`/login`、`/privacy`、`/terms`、`/data-deletion`、`/data-deletion-status/*`、`/_build/*`、`/assets/*`）→ **S3** + ACM certificate (us-east-1) + Route53 A record
- [ ] T032 [P] Create `terraform/modules/github-actions-oidc/` — IAM OIDC provider for GitHub + role for `terraform plan/apply` および 4 Lambda の update-function-code、S3 sync、CloudFront invalidation
- [ ] T033 [P] Create `terraform/modules/observability/` — CloudWatch alarms per `infrastructure.md` §3.8: app-lambda Error > 1%、webhook-lambda Error > 0.5%、ai-worker DLQ ApproximateMessageVisible > 0、ai-worker Duration p95 > 30s、**keep-alive Errors >= 1（即時、DataPointsToAlarm=1）**、**keep-alive Invocations < 1 in 36h** + SNS topic + email subscription
<!-- unit: U2.3 | deps: U2.2 | scope: infra | tasks: T034-T037 | files: ~4 | automation: manual -->
- [ ] T034 Create `terraform/envs/review/{main.tf,variables.tf,providers.tf,backend.tf}` — wire all modules (secrets, queue, app-lambda, webhook-lambda, ai-worker-lambda, keep-alive-lambda, static-site, github-actions-oidc, observability); `backend.tf` は bootstrap の S3 backend を参照
- [ ] T035 Bootstrap state backend: `cd terraform/bootstrap && terraform init && terraform apply`（local state、一度だけ）— 既に T019/T020 で完了済みなら確認のみ
- [ ] T036 **SSM 値投入** per `quickstart.md` §2.6: 上記の SSM Parameter（Meta、Supabase、Anthropic、deletion salt）を CLI で実値投入
- [ ] T037 Apply review environment: `cd terraform/envs/review && terraform init && terraform plan && terraform apply`; outputs（4 Lambda ARN、API GW URL、CloudFront domain、SQS URL/ARN）を確認

### Database schema (Supabase 接続)
<!-- unit: U2.4 | deps: U2.1 | scope: backend | tasks: T038-T044 | files: ~6 | automation: auto -->

- [ ] T038 [P] Install DB deps in `app/`: `drizzle-orm`, `postgres`, `drizzle-kit`, `zod`, `@supabase/supabase-js`
- [ ] T039 Create `app/src/server/db/schema.ts` — **6 entities** per `data-model.md`: **`tenants`（id/slug/name/plan/stripe_customer_id/status）**、`connectedPages` (with **`tenant_id`**, **`page_access_token_encrypted bytea`**), `conversations` (with `tenant_id`), `messages` (with `tenant_id`, `sent_by_auth_uid`), `aiDrafts` (with `tenant_id`), `deletionLog` (with `tenant_id`); include all indexes（tenant_id を含む複合 index）
- [ ] T040 [P] Create `app/src/server/db/client.ts` — `postgres()` connection pool (`prepare: false` for Supabase Transaction Pooler) — **anon role 用と service role 用の 2 系統 export**: `db`（通常クエリ、RLS 有効）、`dbAdmin`（service role、migration / webhook の page_id→tenant_id 解決等の system 操作専用）。後者は使用箇所をレビューで監査する
- [ ] T041 [P] Create `app/drizzle.config.ts` — `schema: "./src/server/db/schema.ts"`, `out: "./src/server/db/migrations"`, `dialect: "postgresql"`, `dbCredentials: { url: process.env.DATABASE_URL }`
- [ ] T042 Run `npx drizzle-kit generate` to produce `app/src/server/db/migrations/0001_init.sql`; PR レビューで SQL 目視確認（**6 テーブル + indexes**）。**RLS ポリシー（tenants 以外の 5 テーブルに `tenant_isolation` ポリシー）を別ファイル `0002_rls.sql` で追加**：`ENABLE ROW LEVEL SECURITY` + `CREATE POLICY tenant_isolation ... USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (...)`
- [ ] T043 [P] Create `app/src/server/db/seed/review.ts` + `npm run db:seed:review` per `quickstart.md` §3.1 — `tenants` に Malbek 行を INSERT (`slug='malbek'`, `plan='free'`, `status='active'`) → SSM master key 取得 → `META_PAGE_ACCESS_TOKEN` env を AES-256-GCM で暗号化 → `connectedPages` を INSERT (`tenant_id`, `page_id`, `page_name`, `page_access_token_encrypted`)
- [ ] T044 Apply migration to Supabase: `DATABASE_URL=$(aws ssm get-parameter ...) npx drizzle-kit migrate`; seed を実行して `connectedPages` 1 行が存在することを確認

### Core shared services（auth / token / messenger / supabase）
<!-- unit: U2.5 | deps: U2.4 | scope: backend | tasks: T045-T053 | files: ~14 | automation: auto -->

- [ ] T045 [P] Create `app/src/server/env.ts` — zod schema validating required env vars (`DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `META_APP_SECRET_SSM_KEY`, `WEBHOOK_VERIFY_TOKEN_SSM_KEY`, `ANTHROPIC_API_KEY_SSM_KEY`, `AWS_REGION`)
- [ ] T046 [P] Create `app/src/server/services/ssm.ts` — generic `getSsmParameter(name, ttl=300)` using `@aws-sdk/client-ssm` `GetParameter` with `WithDecryption: true`; module-level in-memory cache。共通 SSM 取得ヘルパ。Meta App Secret、Anthropic API キー、Supabase URL/keys、master encryption key、deletion-log salt 等で共通利用
- [ ] T047 [P] Create `app/src/server/services/ssm.test.ts` — mock SSM client: cache hit/miss、decryption、TTL 切れ
- [ ] T047a [P] Create `app/src/server/services/crypto.ts` — `encryptToken(plaintext, masterKey) → Buffer` + `decryptToken(blob, masterKey) → string` (AES-256-GCM、形式 `iv(12B)||tag(16B)||ciphertext`) per `data-model.md`「Page Access Token の暗号化」節 + `getMasterKey()` でマスター鍵を SSM から取得しキャッシュ + `getPageAccessTokenForTenant(tenantId)` (RLS 有効なクエリで `connected_pages.page_access_token_encrypted` を取得 → 復号)
- [ ] T047b [P] Create `app/src/server/services/crypto.test.ts` — encrypt → decrypt round-trip、改竄された blob で auth tag 検証失敗、マスター鍵キャッシュ動作
- [ ] T047c [P] Create `app/src/server/db/with-tenant.ts` — `withTenant<T>(tenantId, fn)` トランザクションヘルパ per `data-model.md` 「Drizzle との統合」: `db.transaction(async tx => { await tx.execute(sql\`SET LOCAL app.tenant_id = ${tenantId}::text\`); return fn(tx); })`
- [ ] T047d [P] Create `app/src/server/db/with-tenant.test.ts` — integration: 別 tenant の行が SELECT で見えないこと、INSERT で `tenant_id` が WITH CHECK で強制されること、`SET LOCAL` 未設定の素のクエリで 0 行返ること
- [ ] T048 [P] Create `app/src/server/services/messenger.ts` — `sendMessengerReply({ pageAccessToken, recipientPsid, messageText })`: global `fetch`、`AbortSignal.timeout(5000)`、指数バックオフ (3 回, base 500ms) per `contracts/meta-send-api.md`; 返却型 `{ ok: true, messageId } | { ok: false, error: 'token_expired' | 'outside_window' | ... }`。**トークンは引数で受け取り**（呼び出し側が tenant ごとに復号した値を渡す）
- [ ] T049 [P] Create `app/src/server/services/messenger.test.ts` — MSW で Meta Send API モック
- [ ] T050 [P] Create `app/src/server/services/auth.ts` — `createClient(SUPABASE_URL, SUPABASE_ANON_KEY)` singleton + helper `verifyAccessToken(token)` (内部で `supabase.auth.getUser`) + `refreshSession(refreshToken)` (内部で `supabase.auth.refreshSession`)
- [ ] T051 [P] Create `app/src/server/services/auth.test.ts` — Supabase Auth API を MSW でモック: getUser 成功、access_token 期限切れ → refresh 成功 / 失敗分岐
- [ ] T052 Create `app/src/server/middleware/auth-middleware.ts` — serverFn middleware per `contracts/admin-api.md` 「認証 + テナント解決ミドルウェア」: read `sb-access-token` cookie → `verifyAccessToken` → tenant_id 抽出 → **`tenants WHERE id = $tenant_id AND status = 'active'` で確認**（service role 接続、見つからなければ `/login?error=tenant_suspended` リダイレクト）→ on auth fail call `refreshSession` and reset cookies → on refresh fail redirect `/login?returnTo=...`; expose `{ user: { id, email, tenantId, role } }`
- [ ] T053 [P] Create `app/src/server/services/anthropic.ts` — Anthropic API 呼び出しヘルパ（実体は ai-worker から import するためエクスポート用）。`generateDraft({ history, latestMessageBody })` returns `{ ok: true, body, model, inputTokens, outputTokens, latencyMs } | { ok: false, error }` per `contracts/ai-draft.md`; `@anthropic-ai/sdk` 使用、prompt caching 有効、retry/backoff 実装

### Supabase Auth テストユーザー作成
<!-- unit: U2.6 | deps: U2.4 | scope: infra | tasks: T054 | files: 0 | automation: manual -->

- [ ] T054 Run Supabase Admin API user creation per `quickstart.md` §3.1 — `operator@malbek.co.jp` and `reviewer@malbek.co.jp` を作成、パスワードを SSM `/fumireply/review/supabase/{operator,reviewer}-password` に保管

**Checkpoint Phase 2 終了**: Terraform apply 成功（4 Lambda + SQS + S3/CloudFront）、Supabase プロジェクト + 初期 tenant (Malbek) + 初期ユーザー（`user_metadata.tenant_id` 設定済み）、DB マイグレーション済み（**6 テーブル + RLS ポリシー**）、`withTenant` ヘルパ + `crypto.encrypt/decrypt` ヘルパが integration test で実証、Page Access Token が DB に暗号化保存済み、全共通 service のユニットテスト通過

---

## Phase 3: User Story 1 — Reviewer login + inbox (Priority: P1) 🎯 MVP Core

**Goal**: レビュワーがログインし、Webhook 経由で受信したメッセージが inbox に表示される (FR-001〜004, FR-009〜011, FR-017)

**Independent Test**: `reviewer@malbek.co.jp` でログイン → テスト FB アカウントから Messenger 送信 → 30 秒以内に inbox に表示

### Webhook 受信 Lambda（FR-001〜004, FR-017、FR-022〜FR-024 の起動）
<!-- unit: U3.1 | deps: U2.5 | scope: backend | tasks: T055-T061 | files: ~5 | automation: auto -->

- [ ] T055 [P] [US1] Create `webhook/package.json` — minimal deps: `@aws-sdk/client-sqs`, `@aws-sdk/client-ssm`, `postgres`, `drizzle-orm`, `zod`; engines node 24
- [ ] T056 [P] [US1] Create `webhook/tsconfig.json` + `webhook/vitest.config.ts`
- [ ] T057 [P] [US1] Create `webhook/src/signature.ts` — HMAC-SHA256 verification, `crypto.timingSafeEqual`
- [ ] T058 [P] [US1] Create `webhook/src/signature.test.ts` — valid / invalid / missing header / wrong prefix
- [ ] T059 [US1] Create `webhook/src/handler.ts` — API Gateway HTTP API event 直接ハンドラ per `contracts/meta-webhook.md`:
  - GET: `hub.mode=subscribe` → verify_token を SSM から取得して比較 → `hub.challenge` エコー
  - POST: signature verify → zod payload validation → **service role 接続で `connected_pages WHERE page_id = entry[].id AND is_active=true` から `tenant_id` 解決**（見つからなければ 200 + `unknown_page` ログ）→ **`withTenant(tenant_id, async tx => ...)` 内で** `conversations` upsert + `messages` INSERT (`tenant_id`, `ON CONFLICT (meta_message_id) DO NOTHING RETURNING id`) + `message_type='text'` の場合のみ `ai_drafts` INSERT (`tenant_id`, `status='pending'`, `ON CONFLICT (message_id) DO NOTHING`) → 新規挿入時のみ SQS `SendMessage({ messageId })`（tenant_id は載せない、Worker 側で再解決）→ 200
- [ ] T060 [P] [US1] Create `webhook/src/handler.test.ts` — integration: 実 Meta ペイロードで POST → signature 検証 → DB INSERT 確認 → SQS enqueue 確認（aws-sdk-client-mock）; sticker → ai_drafts 作らず SQS enqueue されない; 重複 mid → 1 件のみ
- [ ] T061 [US1] Update `terraform/modules/webhook-lambda/` — Lambda の zip 成果物が `webhook/dist/` を指すようデプロイパイプラインで参照、API Gateway integration が `/api/webhook` を確実にルーティング（`/api/*` のうち `/api/webhook` のみこの Lambda、それ以外は app-lambda という設定）

### Login（FR-009, FR-010, FR-011）— Supabase Auth
<!-- unit: U3.2 | deps: U2.5 | scope: frontend | tasks: T062-T067 | files: ~6 | automation: auto -->

- [ ] T062 [P] [US1] Create `app/src/routes/(auth)/login/-lib/login.fn.ts` — `loginFn` serverFn per `contracts/admin-api.md`: `supabase.auth.signInWithPassword({ email, password })` → Cookie set (`sb-access-token`, `sb-refresh-token`, HttpOnly, Secure, SameSite=Lax); error mapping (`AuthError invalid_grant` → `invalid_credentials`)
- [ ] T063 [P] [US1] Create `app/src/routes/(auth)/login/-components/LoginForm.tsx` — controlled form (email, password); 成功時 `/inbox` へ navigate
- [ ] T064 [US1] Create `app/src/routes/(auth)/login/index.tsx` — `createFileRoute` with `ssr: false`; `returnTo` クエリ対応
- [ ] T065 [US1] Create `app/src/test/routes/(auth)/login/index.test.tsx` — integration with MSW Supabase Auth mock: 正常ログイン → Cookie set、invalid_credentials 表示
- [ ] T066 [P] [US1] Create `app/src/server/fns/logout.fn.ts` — `logoutFn`: `supabase.auth.signOut()` + Cookie Max-Age=0
- [ ] T067 [P] [US1] Create `app/src/server/fns/logout.test.ts` — unit with mocked Supabase client

### Inbox（FR-002）
<!-- unit: U3.3 | deps: U2.5 | scope: frontend | tasks: T068-T071 | files: ~4 | automation: auto -->

- [ ] T068 [US1] Create `app/src/routes/(app)/inbox/-lib/list-conversations.fn.ts` — `listConversationsFn` serverFn: auth middleware → query `conversations` order by `last_message_at DESC` + latest message body preview (100 文字) + `within_24h_window` calc
- [ ] T069 [P] [US1] Create `app/src/routes/(app)/inbox/-components/InboxList.tsx` — list UI 参考 `mock/inbox-screens.jsx`; **除外**: VIP タグ、AI 分類カテゴリ、顧客管理、優先度（spec.md L181-191 Assumptions 遵守）; 含む: 顧客名（PSID フォールバック）、最終メッセージ preview、unread バッジ、24h 窓ステータス
- [ ] T070 [US1] Create `app/src/routes/(app)/inbox/index.tsx` — SSR route with auth middleware (T052); loader calls `listConversationsFn`, renders `InboxList`
- [ ] T071 [P] [US1] Create `app/src/test/routes/(app)/inbox/index.test.tsx` — integration: fixture 3 conversations → 最新順、未ログインリダイレクト、unread バッジ表示

**Checkpoint US1**: webhook-lambda → DB INSERT + SQS enqueue → inbox 表示のフルパス稼働、reviewer 資格情報でログイン可能

---

## Phase 4: User Story 2 — AI 下書き表示 + Send reply (Priority: P1) 🎯 MVP Core

**Goal**: スレッドを開くと AI 下書きが表示され、確認・編集・送信できる (FR-005〜008, FR-018, FR-022〜FR-026)

**Independent Test**: inbox から会話クリック → 60 秒以内に AI 下書き表示 → そのまま or 編集して送信成功 → テスト FB アカウントの Messenger で受信確認

### AI Worker Lambda（FR-022〜FR-026）
<!-- unit: U4.1 | deps: U2.5 | scope: backend | tasks: T072-T076 | files: ~5 | automation: auto -->

- [ ] T072 [P] [US2] Create `ai-worker/package.json` — minimal deps: `@anthropic-ai/sdk`, `@aws-sdk/client-ssm`, `postgres`, `drizzle-orm`, `zod`
- [ ] T073 [P] [US2] Create `ai-worker/tsconfig.json` + `ai-worker/vitest.config.ts`
- [ ] T074 [P] [US2] Create `ai-worker/src/prompt.ts` — system prompt 定数（TCG retailer customer support）+ `buildUserPrompt({ history, latestBody })` per `contracts/ai-draft.md`
- [ ] T075 [US2] Create `ai-worker/src/handler.ts` — SQS event handler per `contracts/ai-draft.md`:
  - parse `Records[0].body` → `messageId`
  - **service role 接続で `messages.tenant_id` 解決**（見つからなければスキップ成功）
  - **`withTenant(tenant_id, async tx => ...)` 内で** `messages` + 直近 5 件の同 conversation を取得
  - `message_type !== 'text'` ならスキップ成功
  - SSM から Anthropic API キー取得（メモリキャッシュ、全テナント共通）
  - Anthropic API（Claude Haiku 4.5）を `@anthropic-ai/sdk` で呼ぶ、prompt caching 有効、3 回リトライ指数バックオフ
  - 成功時 `withTenant` 内で `ai_drafts` UPDATE (`status='ready'`, `body`, `model`, tokens, `latency_ms`)
  - 失敗時 `withTenant` 内で `ai_drafts` UPDATE (`status='failed'`, `error`); SQS は ACK（throw しない）
  - SDK 例外時のみ throw → SQS が再配信
- [ ] T076 [P] [US2] Create `ai-worker/src/handler.test.ts` — integration: Anthropic API を MSW モック → ai_drafts UPDATE 成功 / 401 失敗 / 429 リトライ / 5xx リトライ / sticker スキップ / 直近会話履歴の prompt 組み立て確認。**FR-026（AI 自動送信禁止 / Human-in-the-Loop 必須）の否定検証**: テスト中に Meta Send API クライアントが**一切呼ばれていないこと**を assert（`expect(metaSendApiMock).toHaveBeenCalledTimes(0)`）。Worker は `ai_drafts` への保存しか行わず、送信は管理画面の人間操作のみであることをテストレベルで担保する

### Thread 表示 + AI 下書き UI（FR-022〜FR-024、FR-005）
<!-- unit: U4.2 | deps: U3.3,U4.1 | scope: frontend | tasks: T077-T085 | files: ~9 | automation: auto -->

- [ ] T077 [US2] Create `app/src/routes/(app)/threads/$id/-lib/get-conversation.fn.ts` — `getConversationFn` per `contracts/admin-api.md`: auth → `conversations` + `messages` (時系列) LEFT JOIN `ai_drafts`、最新 inbound に紐づく ready draft を `latest_draft` として返却 → `UPDATE conversations SET unread_count = 0`
- [ ] T078 [US2] Create `app/src/routes/(app)/threads/$id/-lib/send-reply.fn.ts` — `sendReplyFn` per `contracts/admin-api.md`: auth → tenantId 取得 → **`withTenant(tenantId, async tx => ...)` 内で**：24h window check → `connected_pages.page_access_token_encrypted` を取得 → `crypto.decryptToken` で復号 → INSERT `messages` (`tenant_id`, `send_status='pending'`, `sent_by_auth_uid=user.id`) → `sendMessengerReply({ pageAccessToken, ... })` → UPDATE 結果; 5 秒以内に決着
- [ ] T079 [P] [US2] Create `app/src/routes/(app)/threads/$id/-lib/send-reply.fn.test.ts` — integration with MSW Send API mock: 成功、outside_window、token_expired、meta_error
- [ ] T080 [P] [US2] Create `app/src/routes/(app)/threads/$id/-lib/get-draft-status.fn.ts` — `getDraftStatusFn`: `ai_drafts` を `message_id` で検索、`{ status, body }` 返却（ポーリング用）
- [ ] T081 [P] [US2] Create `app/src/routes/(app)/threads/$id/-components/ThreadMessages.tsx` — 時系列メッセージ表示、direction で左右、`send_status` でアイコン、`ai_draft.status='ready'` の inbound には「AI suggested:」のサブテキスト表示（任意のヒント、操作には影響しない）
- [ ] T082 [P] [US2] Create `app/src/routes/(app)/threads/$id/-components/DraftBanner.tsx` — `latest_draft.status='pending'` 時に「下書き生成中…」表示 + 3 秒ごとに `getDraftStatusFn` ポーリング、ready で消える + ReplyForm の初期値を更新; `failed` でも消える（空入力フォールバック、FR-025）
- [ ] T083 [P] [US2] Create `app/src/routes/(app)/threads/$id/-components/ReplyForm.tsx` — textarea (初期値 `latest_draft.body`)、送信ボタン、24h 窓残り時間表示、エラー表示 (FR-008)
- [ ] T084 [US2] Create `app/src/routes/(app)/threads/$id/index.tsx` — SSR route: loader で `getConversationFn`、`ThreadMessages` + `DraftBanner` + `ReplyForm` をマウント
- [ ] T085 [P] [US2] Create `app/src/test/routes/(app)/threads/$id/index.test.tsx` — integration: メッセージ表示順、unread リセット、`latest_draft.status='ready'` で ReplyForm に初期値、`pending` でバナー表示、`failed` で空入力、24h 超過で送信無効化

### FR-018 Page Access Token 警告
<!-- unit: U4.3 | deps: U3.3 | scope: frontend | tasks: T086-T088 | files: ~3 | automation: auto -->

- [ ] T086 [P] [US2] Create `app/src/server/fns/page-status.fn.ts` — `getPageStatusFn` per `contracts/admin-api.md`: 直近の `messages.send_error='token_expired'` から受動判定（`/me?fields=id,name` の能動チェックは廃止）。5 分サーバーキャッシュ
- [ ] T087 [P] [US2] Create `app/src/routes/(app)/-components/TokenStatusBanner.tsx` — 5 分ごとに `getPageStatusFn` ポーリング (useEffect + setInterval); `token_valid === false` で赤バナー表示
- [ ] T088 [US2] Update `app/src/routes/(app)/__root.tsx` (or layout) に `TokenStatusBanner` をマウント

### 統合テスト + E2E
<!-- unit: U4.4 | deps: U3.1,U4.1,U4.2 | scope: backend | tasks: T089-T093 | files: ~5 | automation: auto -->

- [ ] T089 [P] [US2] Create `app/tests/integration/send-reply.test.ts` — full flow against test DB + MSW Meta API: ログイン → inbox 取得 → threads/$id 取得 → sendReply → DB に outbound メッセージ `sent` で記録
- [ ] T090 [P] [US2] Create `app/tests/integration/ai-draft-worker.test.ts` — Worker handler を SQS event で起動 → MSW Anthropic mock → `ai_drafts.status='ready'` で UPDATE される
- [ ] T091 [P] [US2] Create `app/tests/integration/webhook-receive.test.ts` — webhook handler 経由で実 Meta payload → DB INSERT + SQS enqueue（aws-sdk-client-mock）
- [ ] T092 [P] [US2] Create `app/tests/e2e/review-flow.spec.ts` — Playwright: ログイン → inbox → thread クリック → AI 下書き待機（モック化、即座に `ready` を返す）→ reply 編集 → 送信 → 成功表示
- [ ] T093 [P] Create `.github/workflows/e2e.yml` — nightly trigger: build app → spin up postgres service container → seed → `npm run test:e2e`

**Checkpoint US2**: 管理画面でスレッドを開くと AI 下書きが 60 秒以内に表示され、編集して送信したメッセージが Messenger 実機に到達

---

## Phase 5: User Story 3 — Public pages + data deletion (Priority: P1) 🎯 MVP Core

**Goal**: プライバシー / 利用規約 / データ削除 / 会社情報ページを独自ドメイン HTTPS 配信 (FR-011〜015)。プライバシーポリシーには Anthropic への第三者提供を明記。

**Independent Test**: 各 URL を外部ブラウザから直接開き、HTTPS 有効 + 必須記載事項（取得データ、保存期間、Anthropic 提供、削除窓口、連絡先）を確認

### 公開ページ (静的)
<!-- unit: U5.1 | deps: U2.5 | scope: frontend | tasks: T094-T098 | files: ~5 | automation: auto -->

- [ ] T094 [P] [US3] Create `app/src/routes/(public)/index.tsx` — 会社情報ページ (FR-015)
- [ ] T095 [P] [US3] Create `app/src/routes/(public)/privacy.tsx` — プライバシーポリシー: 取得項目 (Messenger メッセージ本文、PSID、ページ ID)、利用目的、保存期間、**第三者提供（Anthropic）**、削除窓口、連絡先 (FR-012)
- [ ] T096 [P] [US3] Create `app/src/routes/(public)/terms.tsx` — 利用規約 (FR-013)
- [ ] T097 [P] [US3] Create `app/src/routes/(public)/data-deletion.tsx` — データ削除手順ページ + Meta コールバック動作説明 + ai_drafts も削除対象である旨 (FR-014)
- [ ] T098 [US3] Configure SSG prerender: update `app/vite.config.ts` / TanStack Start config to mark `(public)/*` routes as `prerender: true`; `npm run build` 成果物に静的 HTML が出力されること確認
### データ削除コールバック
<!-- unit: U5.2 | deps: U2.4 | scope: backend | tasks: T099-T103 | files: ~5 | automation: auto -->

- [ ] T099 [P] [US3] Create `app/src/routes/api/data-deletion/-lib/delete-user-data.ts` — transaction: `conversations` where `customer_psid = $psid` → DELETE `messages` (CASCADE で `ai_drafts` も削除) → DELETE `conversations` → INSERT `deletion_log` with `psid_hash = sha256(salt || psid)` + random `confirmation_code`
- [ ] T100 [P] [US3] Create `app/src/routes/api/data-deletion/-lib/delete-user-data.test.ts` — integration: fixture PSID 削除 → messages/conversations/ai_drafts 消える、deletion_log 行追加
- [ ] T101 [US3] Create `app/src/routes/api/data-deletion/index.ts` — POST handler per `contracts/data-deletion-callback.md`: signed_request HMAC verify → user_id 抽出 → `delete-user-data` 実行 → JSON 返却
- [ ] T102 [P] [US3] Create `app/src/test/routes/api/data-deletion/index.test.ts` — integration: valid signed_request → 200 + JSON、invalid → 400
- [ ] T103 [US3] Create `app/src/routes/(public)/data-deletion-status/$code.tsx` — SSR route: `deletion_log` から code で検索、「Deleted」or「Not found」のみ
### デプロイパイプライン
<!-- unit: U5.3 | deps: U2.3,U3.1,U4.1 | scope: infra | tasks: T104 | files: ~1 | automation: auto -->

- [ ] T104 Create `.github/workflows/deploy-app.yml` — on merge to main: build (app, webhook, ai-worker, keep-alive) → upload SSG output + CSR login + assets to S3 → CloudFront invalidation → 4 Lambda zip → `aws lambda update-function-code` × 4 per `infrastructure.md` §6.2

**Checkpoint US3**: 4 公開 URL が独自ドメイン HTTPS で配信、データ削除コールバックが ai_drafts も含めて削除、CloudFront ルーティングが正

---

## Phase 6: User Story 4 — Screencast (Priority: P1) 🎯 MVP Core

**Goal**: 権限ごとの使用箇所と Human-in-the-Loop を明示したスクリーンキャスト動画 (FR-019, FR-026)

**Independent Test**: 動画を第三者に見せて「どの画面/操作/権限/価値」+「AI 下書きと人間の承認の関係」が明示できているか確認

### Screencast 制作
<!-- unit: U6.1 | deps: U3.2,U3.3,U4.2 | scope: docs | tasks: T105-T108 | files: ~2 | automation: manual -->

- [ ] T105 [P] [US4] Create `docs/review-submission/screencast-script.md` — 撮影台本 per R-007: シーン 1 ログイン、2 inbox、3 スレッド開く + AI 下書き表示、4 編集して送信（送信ボタン押下を強調）、各シーンで権限名と「AI generates a draft only — humans always click Send」を字幕表示するタイミング明記
- [ ] T106 [P] [US4] Create `docs/review-submission/reviewer-credentials.md` — レビュワー認証情報 + テスト FB ページ手順 (FR-010, FR-021)
- [ ] T107 [US4] Record screencast: review 環境に対し実動作でログイン→inbox→スレッド→AI 下書き表示→編集→送信のフルパスを画面収録
- [ ] T108 [US4] Edit screencast: 字幕 / ナレーション 追加（権限名 + Human-in-the-Loop 明示）、MP4 export、100MB 以下・2〜3 分以内

---

## Phase 7: User Story 5 — Use Case description (Priority: P2)

**Goal**: AI 下書きを主機能として記述しつつ Phase 2 機能拡張が同一権限スコープで読み取れる Use Case 説明文 (FR-020, SC-007)

### Use Case 説明文
<!-- unit: U7.1 | deps: U2.5 | scope: docs | tasks: T109-T110 | files: ~1 | automation: manual -->

- [ ] T109 [P] [US5] Create `docs/review-submission/use-case-description.md` — 英語 per R-008 テンプレート: AI-assisted reply drafting を主機能、Anthropic 第三者提供を明記、Human-in-the-Loop 明示、Phase 2 機能 (AI 自動分類, 顧客管理, 商品管理, Slack 通知, Instagram DM) を同一スコープで記述
- [ ] T110 [US5] Third-party review of `use-case-description.md`、指摘を反映

---

## Phase 8: Polish & Submission Preparation — Sprint 5-6

**Purpose**: 審査提出直前の仕上げ。CloudWatch / deploy pipeline / ドキュメント / 最終リハーサル。

### keep-alive Lambda
<!-- unit: U8.1 | deps: U2.3 | scope: backend | tasks: T111 | files: ~3 | automation: auto -->

- [ ] T111 [P] Create `keep-alive/package.json` + `keep-alive/src/handler.ts` + `keep-alive/src/handler.test.ts` — Supabase Pooler に SELECT 1 を発行する Lambda (FR-027)。**指数バックオフ 3 回リトライ（500ms / 1.5s / 4.5s）**、3 回失敗時は SNS Publish で即時通知 + 構造化ログ `keepalive_critical` 出力 + throw（EventBridge 自動リトライへ）。テストは MSW 不要（postgres クライアントを mock）、リトライ動作・SNS Publish・throw 動作を unit テスト
### 運用ランブック
<!-- unit: U8.2 | deps: U2.5 | scope: docs | tasks: T112 | files: ~1 | automation: manual -->

- [ ] T112 [P] Create `docs/operations/audit-runbook.md` — 審査期間中の監視手順 + 障害時のリカバリ手順を網羅:
  - Supabase keep-alive 失敗時の対応（手動 Resume + EventBridge Rule 確認 + 通知系統再点検）
  - ai-worker DLQ 監視と再投入手順
  - CloudWatch アラーム（app/webhook/ai-worker Errors、keep-alive Errors / Invocations なし）の対応フロー
  - deletion_log の 3 年超過分の手動 cleanup SQL
  - Page Access Token 失効時の長期トークン再取得 → 暗号化 → DB UPDATE 手順
  - Supabase reviewer 無効化/有効化 + パスワードローテーション手順
  - **🚨 マスター暗号化鍵（`/fumireply/master-encryption-key`）紛失時の復旧手順**（必須）:
    1. SSM に新しいマスター鍵を生成 → 投入（`openssl rand -hex 32`）
    2. **全テナントの Page Access Token は復号不能になる**（旧鍵紛失のため）
    3. 各テナントの運用者に連絡し、Meta Business Manager から長期 Page Access Token を再取得依頼
    4. 取得したトークンを seed スクリプト（または管理画面の手動 UPDATE）で新鍵により暗号化して `connected_pages.page_access_token_encrypted` に上書き
    5. インシデント記録に紛失原因 + 影響テナント + 復旧時刻を残す
    6. 鍵バックアップ運用の見直し（Phase 2 で AWS KMS 移行 + 多鍵運用 + バージョン管理を検討）
  - **🚨 マスター鍵ローテーション運用（紛失予防）の手順骨子**: Phase 2 で正式整備するが MVP では「マスター鍵を SSM から外部に出さない」「Terraform state にも書かない」「`audit-runbook.md` の物理コピーを安全な場所に控える（運用者しかアクセスできない暗号化ストレージ）」だけは明記
### CloudWatch alarms + apply pipeline
<!-- unit: U8.3 | deps: U2.2 | scope: infra | tasks: T113-T114 | files: ~1 | automation: manual -->

- [ ] T113 [P] Enable CloudWatch alarms in `terraform/envs/review/main.tf` — `terraform apply`
- [ ] T114 [P] Create `.github/workflows/terraform-apply.yml` — on merge to main, paths `terraform/**`: manual approval gate → `terraform apply` via OIDC role
### テスト FB ページ + スモークテスト + SLA 検証
<!-- unit: U8.4 | deps: U5.3,U4.4 | scope: infra | tasks: T115-T122 | files: 0 | automation: manual -->

- [ ] T115 [P] **Create test Facebook page** in Meta Business Manager (FR-021)。**🚨 推奨着手タイミング：Phase 5 末尾（Sprint 5 中）まで**に完了させる。T100 / T117 / T120 等の手動スモークテストとレビュワー検証が本タスクをブロッカとして必要とするため、Phase 8 着手時点ではすでに完了している状態を作る：operator アカウントがページ管理者権限、Messenger 受信を有効化、Webhook 購読、short-lived Page Access Token を取得 → seed スクリプトの環境変数として `META_PAGE_ID` / `META_PAGE_NAME` / `META_PAGE_ACCESS_TOKEN` を実値に差し替え → `npm run db:seed:review` 再実行（マスター鍵で暗号化されて `connected_pages` に保存される）
- [ ] T116 Verify Page Access Token は長期トークン化 per `quickstart.md` §2.4（**T115 完了後**）→ 取得した長期トークンで再度 seed スクリプトを実行し AES-256-GCM 暗号化して `connected_pages.page_access_token_encrypted` を更新
- [ ] T117 Manual smoke test (FR-001〜008, FR-022〜FR-026)（**T115 + T116 完了後**）: テスト FB アカウントから Messenger 送信 → 30 秒以内に inbox 反映 (SC-003) → スレッド開く → 60 秒以内に AI 下書き表示 (SC-008) → 編集して送信 → 5 秒以内に Messenger 受信 (SC-004); 失敗ケースも再現（トークン失効、24h 超過、Anthropic API キー失効）
- [ ] T118 [P] **Verify FR-017 Webhook 20-second SLA** via CloudWatch Logs Insights 直近 48 時間: webhook-lambda の duration p95 < 2000ms / p99 < 5000ms / max < 20000ms。違反時は Phase 2 で Provisioned Concurrency 検討
- [ ] T119 [P] **Verify SC-002 login → inbox p95 < 10 seconds**: reviewer で 5 回ログイン測定、p95 を `audit-runbook.md` に記録
- [ ] T120 [P] **Verify SC-008 AI 下書き p95 < 60 seconds**: 10 件のテストメッセージで「webhook 受信 → ai_drafts.status='ready'」までのレイテンシを CloudWatch Logs / DB タイムスタンプ差分で測定、p95 を `audit-runbook.md` に記録
- [ ] T121 [P] **Verify FR-027 Supabase keep-alive**: EventBridge Rule + keep-alive Lambda の Invocations を CloudWatch Metrics で確認、**過去 24 時間に 1 回 + 過去 7 日で 7 回**の起動実績を確認。失敗注入テスト（postgres URL を一時的に壊す）→ 内部リトライ → SNS 通知到達まで End-to-End 検証
- [ ] T121a [P] **Verify RLS テナント分離**：staging で 2 つ目の tenant（`acme`）を一時的に作成 → Malbek の reviewer JWT で acme の messages を SELECT しても 0 行が返ること、`SET LOCAL app.tenant_id = '<acme-uuid>'` を Malbek 接続でセットしても他テナントの page_access_token を decrypt できないこと、を integration / E2E で確認 → 確認後 acme tenant を削除
- [ ] T122 Verify 公開 4 URL: `curl -I https://<domain>/`, `/privacy`, `/terms`, `/data-deletion`, `/data-deletion-status/test` がすべて HTTPS + 200 (SC-006)
### 24/7 稼働確認 + 申請提出
<!-- unit: U8.5 | deps: U8.4 | scope: docs | tasks: T123-T125 | files: ~1 | automation: manual -->

- [ ] T123 Verify 24/7 稼働（審査期間全体の累積観測）: 審査提出日から結果通知日まで、CloudWatch メトリクス/ログを日次で記録し、管理画面・Webhook・公開ページ群の累積稼働率が 99.5% 以上であることを `audit-runbook.md` に集計 (FR-016, SC-005)
- [ ] T124 Update `specs/001-mvp-app-review/quickstart.md` §6「審査提出前チェックリスト」 — 全項目をチェック済みに更新
- [ ] T125 Submit Meta App Review: App Dashboard フォームで Webhook Callback URL + Privacy + Terms + Data Deletion + 管理画面 URL + screencast + use case description + reviewer credentials を全項目入力、`pages_messaging` / `pages_manage_metadata` / `pages_read_engagement` をリクエスト、submit

**Checkpoint 審査提出完了**: Meta 申請フォーム全項目入力済み、submit 完了、申請 ID 取得

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: 依存なし、即時開始可。CI 緑が Phase 2 着手の前提
- **Phase 2 (Foundational)**: Phase 1 完了後。**すべての US をブロック**。Supabase プロジェクト作成（T023）と Anthropic API キー（T024）が外部依存の最初
- **Phase 3〜5 (US1, US2, US3)**: Phase 2 完了後、並列実行可
- **Phase 6 (US4 Screencast)**: US1 + US2 の実装完了 + デプロイ済みが前提
- **Phase 7 (US5 Use Case)**: 並行可能だが第三者レビュー (T110) は US1〜US4 概ね完了後
- **Phase 8 (Polish & Submission)**: US1〜US4 + 必要に応じ US5 完了後

### User Story Dependencies

- **US1 (Login + Inbox)**: Phase 2 完了で開始可、他 US への依存なし
- **US2 (AI Draft + Send Reply)**: Phase 2 完了で開始可だが、US1 の inbox route 作成後が現実的（E2E が書きやすい）
- **US3 (Public Pages)**: Phase 2 完了で独立開始可
- **US4 (Screencast)**: US1 + US2 実機動作が前提（AI 下書き表示が含まれるため）
- **US5 (Use Case)**: Phase 2 完了で独立開始可（ドキュメントのみ）

### Within Each User Story

- Tests (T058, T060, T065, T067, T071, T076, T079, T085, T089〜T092, T100, T102) は実装前に書いて fail 確認
- `-lib/*.ts` (serverFn / core logic) → `-components/*.tsx` (UI) → `index.tsx` (route 組み立て) → `src/test/routes/**/*.test.tsx`
- 各 User Story の checkpoint を通過してから次の US へ

---

## Parallel Opportunities

### Phase 2 Foundational

```
T023 + T024: 外部サービス作成、並行実行可
T025〜T033: Terraform 各モジュールは独立ファイル、並行実行可（VPC/RDS/Cognito 廃止により大幅にシンプル化）
T038〜T053: app パッケージ install 後、別ファイル、並行可
```

### Phase 3 US1

```
Webhook Lambda サブツリー (T055〜T061) と Login (T062〜T067) と Inbox (T068〜T071) は独立、3 並列化可
```

### Phase 4 US2

```
AI Worker サブツリー (T072〜T076) と Thread UI (T077〜T085) と Token banner (T086〜T088) は独立、3 並列化可
T089 + T090 + T091 + T092: 統合 / E2E / Worker / Webhook 統合テストは各々独立
```

### Phase 5 US3

```
T094〜T097: 4 公開ページは完全独立、4 並列可
T099 + T100: -lib 内で別ファイル、並行可
```

---

## Implementation Strategy

### MVP Path (Meta 申請提出まで)

1. **Sprint 1 (Phase 1)**: Walking Skeleton、CI 緑（完了済み）
2. **Sprint 2 (Phase 2)**: Supabase + Infrastructure + DB + 共通サービス、この checkpoint は絶対死守。VPC/RDS/Cognito を廃止したことで旧版より着地が早いはず
3. **Sprint 2〜3 (Phase 3 = US1)**: webhook-lambda + 受信 + login + inbox → 中間デモ可
4. **Sprint 3〜4 (Phase 4 = US2)**: AI Worker Lambda + 下書き UI + 送信パス、Messenger 実機到達 → 申請スコープ網羅完了
5. **Sprint 2〜3 並行 (Phase 5 = US3)**: 公開ページ + データ削除 → 申請フォーム URL 入力可能
6. **Sprint 4〜5 (Phase 6 = US4)**: 動画撮影・編集（AI 下書き → 編集 → 送信を強調）
7. **Sprint 5 (Phase 7 = US5)**: Use Case 説明文（AI を主機能）
8. **Sprint 5〜6 (Phase 8)**: 仕上げ + 申請提出 (T125)

### Incremental Delivery Checkpoints

- 各 Phase の Checkpoint ごとに `quickstart.md` §6 チェックリストを部分的に埋める
- US1 完了時点で内部デモ可能（review 環境に Webhook 到達 + inbox 表示 + SQS enqueue）
- US2 完了時点で AI 下書き機能まで稼働 → 申請準備の大半が整う
- US3 完了時点で公開 URL が全部入る（申請フォームの必須 URL 4 本 + Webhook URL）
- Phase 8 で 48 時間稼働確認 + Supabase keep-alive 確認を終えて提出

### Sprint 対応表（plan.md §Sprint 計画と一致）

| Sprint | plan.md Tasks | 対応 tasks.md Phase |
|--------|---------------|---------------------|
| Sprint 1 | Walking Skeleton | Phase 1 (T001〜T022) |
| Sprint 2 | Infrastructure + 公開ページ + Supabase Auth | Phase 2 (T023〜T054) + Phase 5 先行 (T094〜T097) |
| Sprint 3 | US1 + US2 着手 + E2E | Phase 3 (T055〜T071) + Phase 4 着手 (T072〜T076) |
| Sprint 4 | US2 完結 + screencast ドラフト | Phase 4 完結 (T077〜T093) + Phase 6 ドラフト (T105〜T106) |
| Sprint 5 | screencast 撮影 + Use Case + data deletion + **テスト FB ページ準備（T115）** | Phase 5 完結 (T098〜T104) + Phase 6 (T107〜T108) + Phase 7 (T109〜T110) + **T115 前倒し**（Phase 8 のスモークテストブロッカ解消のため）|
| Sprint 6 | 提出リハーサル | Phase 8 (T111〜T125、T125 が最終 submit) |

---

## Notes

- `[P]` は別ファイル・依存なしタスク。並列化のヒント。
- `[US1]〜[US5]` は spec.md の User Story に対応。
- 全タスクはコロケーション構造 (`routes/<path>/index.tsx` + `-components/` + `-lib/`) と TanStack 公式テストガイドの `src/test/routes/` ミラー配置に従う。Webhook / AI Worker / keep-alive Lambda は独立ディレクトリ（`webhook/src/`、`ai-worker/src/`、`keep-alive/src/`）でコロケーションテスト。
- **axios 禁止**：全外部 HTTP は `fetch`（CLAUDE.md 記載の memory 準拠）。Anthropic SDK は内部で fetch を使うため OK。
- **VPC/NAT/RDS/Cognito 廃止**：これらモジュールは Phase 2 のタスクから外した。旧 tasks.md の T023（networking）、T024（database）、T025（auth=Cognito）は削除済み
- **マルチテナント前提**：全 DB アクセスは `withTenant(tenantId, fn)` で囲む。RLS が DB レイヤで防衛、middleware が JWT から tenant_id を抽出。Page Access Token は `connected_pages.page_access_token_encrypted` (AES-256-GCM)。service role は migration / webhook の page_id→tenant_id 解決等の system 操作専用、PR レビューで service role 使用箇所を必ず監査
- **Phase 2（審査通過後）の主要拡張**：セルフサインアップ + Stripe 課金（`/signup` 画面、tenant 作成 fn、Stripe Webhook Lambda、プラン管理）。これは MVP には含まないが、本 tasks.md の DB スキーマと middleware は最初から対応している
- Phase 2+ 機能（AI 自動分類, Slack, Instagram, 顧客/商品管理）は本 tasks.md の範囲外。審査通過後に別 feature branch で追加。
- 各タスク完了後に commit 推奨。
