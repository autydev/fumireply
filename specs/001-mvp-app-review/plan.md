# Implementation Plan: MVP for Meta App Review Submission

**Branch**: `001-mvp-app-review` | **Date**: 2026-04-20 | **Updated**: 2026-04-30 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-mvp-app-review/spec.md`

## Summary

Meta App Review 通過に必要な最小機能（Messenger 受信 → AI 下書き生成 → 管理画面で確認・編集 → Send API で返信）を実装する。AI 下書き生成は Anthropic API（Claude Haiku 4.5）を SQS 経由の Worker Lambda で非同期実行し、送信は管理画面のボタンから同期的に行う Human-in-the-Loop 構成。

**アーキテクチャ要点**（詳細は research.md / infrastructure.md）:
- **TanStack Start + Lambda Web Adapter** で SSR フロントを Lambda にデプロイ。公開ページは S3 + CloudFront で静的配信、管理画面と API のみ Lambda。
- **Webhook 受信 Lambda は同期で 署名検証 → page_id から tenant_id 解決 → DB INSERT → SQS enqueue → 200**。AI 下書き生成は **Worker Lambda** に分離し、Anthropic API を非同期で呼ぶ。Send API 呼び出しは管理画面の `createServerFn` から同期的に実行（人間トリガ）。
- **マルチテナント前提**：DB スキーマ・middleware・JWT claim は最初からマルチテナント対応。MVP では tenant 1 件（Malbek）を seed。セルフサインアップ + Stripe 課金は Phase 2。
- **DB = Supabase Postgres（東京リージョン、無料プラン）**。Drizzle ORM で型安全アクセス。**RLS を全テナント所有テーブルで ON**（多層防御の最後の砦）。`withTenant(tenant_id, fn)` トランザクションヘルパで `SET LOCAL app.tenant_id` を流す。EventBridge keep-alive Lambda で Pause 回避（FR-027）。
- **認証 = Supabase Auth**（メール+パスワード、JWT は HttpOnly Cookie）。`user_metadata.tenant_id` で所属テナントを表現。Cognito / DB セッションテーブルは持たない。
- **Lambda は VPC 外配置**。NAT Gateway / RDS Proxy / Cognito モジュールは廃止。Supabase / Anthropic / Meta は外向き HTTPS で直接呼ぶ。
- **Page Access Token は DB に AES-256-GCM 暗号化保存**（`connected_pages.page_access_token_encrypted`、bytea）。マスター鍵は SSM `/fumireply/master-encryption-key`。テナント増加時に SSM 操作不要。
- 機密情報は **AWS SSM Parameter Store**（SecureString）で管理（マスター鍵 + 全テナント共通の Meta App Secret 等）。Secrets Manager は MVP では採用しない。
- 実装 1 週目で CI（GitHub Actions）を Walking Skeleton として構築し、PR でテストと Terraform plan が自動検証される状態を先に作る（R-011）。

AI 自動分類 / Instagram DM / Slack 通知 / 顧客管理 / 商品管理は MVP Out of Scope（spec.md）。審査通過後に同一 App ID 配下で段階的に追加する。

## Technical Context

**Language/Version**: TypeScript（最新安定版、5.x または 6 系）/ Node.js 24.x（AWS Lambda の `nodejs24.x` ランタイム、2026-04 時点で GA 済み。`package.json` の `engines` と Terraform の `runtime` で一括管理）。
**Package Manager**: npm（lockfile = `package-lock.json`）。pnpm / yarn は使用しない。CI は `npm ci` でインストールし、lockfile の更新は PR 内で `npm install` を実行した結果のみをコミットする。

**HTTP クライアント方針**: Meta Graph API / Send API / Anthropic API / Data Deletion Callback 等の外部 HTTP 呼び出しは、**グローバル `fetch`（Node.js 24 native / WHATWG Fetch）で実装する**。`axios` および axios ラッパーの新規導入は禁止（最近の脆弱性報告により依存を避ける運用判断）。タイムアウトは `AbortSignal.timeout(ms)`、リトライは自前ヘルパで指数バックオフを実装する（`contracts/meta-send-api.md` §Retry Strategy / `contracts/ai-draft.md` §Retry Strategy に従う）。Anthropic SDK（`@anthropic-ai/sdk`）は内部で fetch を使うため利用してよい。

**Primary Dependencies**:
- `@tanstack/react-start` — SSR + `createServerFn` でフロント API を兼務
- `@tanstack/react-router` — 型安全ルーティング
- `aws-lambda-web-adapter`（Lambda レイヤとして利用、または Dockerfile 内で COPY）— TanStack Start の Node HTTP サーバを Lambda 上でそのまま起動
- `drizzle-orm` + `postgres` — 型安全な Postgres アクセス（接続先は Supabase）
- `@supabase/supabase-js` — Supabase Auth クライアント（認証フローのみ。データ操作は Drizzle で行う）
- `@anthropic-ai/sdk` — Claude Haiku 4.5 呼び出し（Worker Lambda）
- `@aws-sdk/client-ssm` — SSM Parameter Store からのシークレット取得
- `@aws-sdk/client-sqs` — Webhook Lambda から SQS への enqueue
- `zod` — Webhook ペイロードと API 入出力の検証

**Infrastructure**: Terraform 1.6+（S3 バックエンド + DynamoDB ロック）。詳細なモジュール設計・依存関係・コスト試算・セキュリティ設計は [`infrastructure.md`](./infrastructure.md) を参照。

**Storage**: **Supabase Postgres**（東京リージョン `ap-northeast-1`、無料プラン）。AWS RDS / VPC / RDS Proxy は使用しない。接続は Supabase の Pooler エンドポイント（pgBouncer 互換、Transaction mode）を使用し、Lambda 単位の短命接続でも接続枯渇しない構成にする。

**Testing & CI**:
- **CI First（Walking Skeleton）**：実装 1 週目で GitHub Actions を先に構築し、空のアプリ + テスト 1 件が PR で自動検証される状態を作る（詳細は R-011）。機能追加は CI 稼働後から。
- `vitest` — ユニット + 統合テスト（Webhook 署名検証、Send API モック、Anthropic API モック、DB マイグレーション適用後の CRUD）
- `playwright` — 受信 → 下書き表示 → 編集 → 送信の E2E スモーク（ローカル + プレビュー環境）
- Meta 側の実機疎通は手動スモーク（テスト FB ページ + Messenger アプリ）
- Anthropic API は MSW でモック（テストでは実 API を叩かない）
- Terraform：`terraform fmt -check` + `validate` + PR 上で `plan` 結果をコメント投稿
- AWS 認証：GitHub Actions は OIDC ベースの IAM Role 引き受け（長期アクセスキー不使用）

**Target Platform**: AWS Lambda + API Gateway（HTTP API）+ S3/CloudFront（静的生成ページ配信）+ SQS + EventBridge。DB は Supabase（東京リージョン、AWS 外）。Anthropic API は外部 HTTPS。独自ドメイン配下に CloudFront 経由で配信。

**Project Type**: Web application — TanStack Start モノリス 1 本 + 補助 Lambda 2 本（Webhook 受信、AI 下書き Worker、keep-alive）。ルート単位で**レンダリング戦略を使い分ける**（詳細は R-010 参照）：

| ルート | モード | ホスティング | 理由 |
|--------|--------|--------------|------|
| `/`（会社情報）、`/privacy`、`/terms`、`/data-deletion` | **SSG**（ビルド時静的生成）| S3 + CloudFront | 静的コンテンツ、審査必須ページ、ダウンタイム耐性を最優先 |
| `/login` | **CSR**（クライアントレンダリング）| S3 + CloudFront | 認証前でレンダリング対象データなし、Lambda 不要 |
| `/inbox`, `/threads/$id` | **SSR** | Lambda（Web Adapter 経由）| 認証チェック + データフェッチを統合、初期表示を速く |
| `/api/webhook` | **HTTP route** | **Webhook 受信 Lambda（独立関数）** | 同期で 200 を返すため SSR Lambda と分離、コールドスタート最小化 |
| `/api/data-deletion`、`createServerFn` 全般 | **Server-only** | SSR Lambda | API / Webhook 処理 |

**Performance Goals**:
- Webhook 受信 Lambda のコールドスタート + 処理時間で p95 < 2 秒、p99 < 5 秒（Meta の 20 秒 SLA に十分なマージン）。署名検証 + DB INSERT + SQS enqueue のみで AI 呼び出しは含めない。
- AI 下書き生成（受信 → ai_drafts.ready）p95 < 60 秒（SC-008）
- 公開ページ（SSG）初期表示 p95 < 500ms（CloudFront エッジキャッシュから配信）
- 管理画面（SSR）初期表示 p95 < 3 秒（CloudFront キャッシュ + Lambda ウォーム時）
- Send API 呼び出しは p95 < 3 秒で応答

**Constraints**:
- **Meta Webhook は 20 秒以内に 200 必須**：受信 Lambda は AI 呼び出しを含めず、SQS 分離により p95 < 2 秒で確実に応答する設計。
- **HTTPS 必須**：CloudFront に ACM 証明書をセットし独自ドメイン配下を HTTPS 化。
- **24/7 稼働**：Lambda は常時起動不要（オンデマンド）。Supabase は無料プランで 7 日無アクティブ Pause があるため EventBridge Scheduled Rule + keep-alive Lambda で 1 日 1 回 SELECT 1 を発行する（FR-027）。
- **Page Access Token の長期化**：Meta Graph API で `fb_exchange_token` を介して長期トークン化し、AES-256-GCM で暗号化して `connected_pages.page_access_token_encrypted` に格納（マスター鍵は SSM `/fumireply/master-encryption-key`）。
- **ユーザー認証**：Supabase Auth が JWT を発行し、アプリ側は HttpOnly Cookie で受け取る。DB にユーザーテーブル／セッションテーブルを持たない。JWT には `user_metadata.tenant_id` がクレームとして入る。
- **テナント分離**：middleware が JWT から `tenant_id` を抽出 → `tenants.status='active'` を確認 → 全 DB 操作を `withTenant(tenant_id, async (tx) => {...})` で囲み、`SET LOCAL app.tenant_id = '<uuid>'` を流して RLS を有効化する。
- **AI 自動送信禁止**：FR-026。Worker Lambda は `ai_drafts` を保存するのみで、Send API は呼ばない。

**Scale/Scope**:
- 想定アクセス：審査期間中のレビュワー 1〜2 名 + 自社オペレーター 1 名 = **同時ユーザー 3 名程度**
- 想定メッセージ数：審査中の手動テストで 1 日 10〜30 件程度
- 画面数：管理画面 2 画面（受信一覧、スレッド詳細）+ ログイン画面 + 公開ページ 4 種（プライバシー、利用規約、データ削除、会社情報）= 7 画面
- LOC 目安：~2800 行（Worker Lambda + AI 呼び出し + マルチテナント基盤 / RLS / 暗号化ヘルパで +800 行）

## Constitution Check

*GATE: Phase 0 研究の前に必ずパス、Phase 1 設計後に再チェック。*

**プロジェクト憲法の状態**: `.specify/memory/constitution.md` は未ラティファイ（テンプレートのまま）。本プランでは業界標準のゲートを暫定適用する：

| ゲート | 判定 | 根拠 |
|--------|------|------|
| **YAGNI（不要機能を入れない）** | ⚠️ CONDITIONAL | 仕様の Out of Scope を厳守。AI 自動分類、Instagram DM、Slack 通知、顧客管理、商品管理、トーン設定、AI 自動送信はすべて除外済み。マルチテナントは本計画の基盤要件として採用済みのため除外対象ではない。 |
| **単一責任（1 機能 1 ストーリー）** | ✅ PASS | User Story 1〜5 が独立テスト可能で、それぞれ独立にデモできる。 |
| **テスト可能性** | ✅ PASS | Webhook 署名検証・送信ロジック・認証・AI 下書き生成はユニットテスト可能。受信→下書き表示→送信フローは E2E で検証可能。 |
| **シンプル優先** | ✅ PASS | Lambda は SSR + Webhook 受信 + AI Worker + keep-alive の 4 関数。Webhook と Worker の分離は Meta 20 秒制約と AI 数秒レイテンシのトレードオフから必然。複雑さの正当化済み。 |
| **観測性** | ✅ PASS | CloudWatch Logs に構造化ログ出力。Webhook 受信・SQS enqueue・AI 生成・送信成功/失敗・署名検証失敗をすべて記録。 |
| **可逆性（Phase 2 への移行容易性）** | ✅ PASS | Worker Lambda の Anthropic 呼び出しを差し替えれば AI 自動分類・別モデル・社内 LLM 等に移行可能。Supabase → AWS RDS の移行も Drizzle スキーマ流用で可能。 |

**複雑性の正当化**: SQS + Worker Lambda の追加は「Meta 20 秒 SLA + AI 呼び出しレイテンシ（数秒）」の物理制約による必然。同期実装は不可。

## Project Structure

### Documentation (this feature)

```text
specs/001-mvp-app-review/
├── spec.md              # 仕様書（更新済み）
├── plan.md              # 本ファイル
├── research.md          # Phase 0 成果物（技術選定ログ）
├── data-model.md        # Phase 1 成果物（DB スキーマ）
├── infrastructure.md    # Phase 1 成果物（Terraform モジュール設計 + CI/CD + コスト）
├── quickstart.md        # Phase 1 成果物（セットアップ手順）
├── contracts/           # Phase 1 成果物（API 契約）
│   ├── meta-webhook.md
│   ├── meta-send-api.md
│   ├── data-deletion-callback.md
│   ├── admin-api.md
│   └── ai-draft.md      # Anthropic API 呼び出し契約（Worker Lambda）
├── checklists/
│   └── requirements.md  # 品質チェックリスト
└── tasks.md             # /speckit.tasks で生成
```

### Source Code (repository root)

```text
app/                              # TanStack Start アプリ（ルート単位コロケーション + 公式テストガイド準拠）
├── src/
│   ├── routes/                   # `-` prefix の名前はルート化対象外（routeFileIgnorePrefix 既定値）
│   │   ├── __root.tsx            # 共通レイアウト
│   │   ├── (public)/             # SSG（prerender: true） → S3 配信
│   │   │   ├── index.tsx         # 会社情報（TOP）
│   │   │   ├── privacy.tsx       # プライバシーポリシー
│   │   │   ├── terms.tsx         # 利用規約
│   │   │   └── data-deletion.tsx # データ削除手順
│   │   ├── (auth)/               # CSR（ssr: false） → S3 配信
│   │   │   └── login/
│   │   │       ├── index.tsx           # ルート本体
│   │   │       └── -components/        # ルート専用 UI
│   │   │           └── LoginForm.tsx
│   │   ├── (app)/                # SSR → Lambda（認証必須・管理画面）
│   │   │   ├── inbox/
│   │   │   │   ├── index.tsx           # 受信一覧
│   │   │   │   └── -components/
│   │   │   │       └── InboxList.tsx   # mock/inbox-screens.jsx を参考
│   │   │   └── threads/
│   │   │       └── $id/
│   │   │           ├── index.tsx       # スレッド詳細 + AI 下書き表示 + 返信送信
│   │   │           └── -components/
│   │   │               ├── ThreadMessages.tsx
│   │   │               ├── DraftBanner.tsx   # 「AI 下書き生成中…」表示
│   │   │               └── ReplyForm.tsx     # ai_drafts.body を初期値にセット
│   │   └── api/                  # Server-only → Lambda
│   │       ├── data-deletion/
│   │       │   └── index.ts            # Meta データ削除コールバック（SSR Lambda 内）
│   │       └── webhook/                # ※ Webhook は別 Lambda にビルドする（下記 webhook/ ディレクトリ参照）
│   ├── test/                     # 公式ガイド準拠：routes/ をミラーする並行構造
│   │   ├── setup.ts                    # vitest セットアップ（global mocks, MSW 等）
│   │   ├── file-route-utils.tsx        # createRouter モック、renderWithRouter 等の共通ユーティリティ
│   │   └── routes/                     # routes/ と同じ階層でルート単位テストを配置
│   │       ├── (auth)/
│   │       │   └── login/
│   │       │       └── index.test.tsx
│   │       ├── (app)/
│   │       │   ├── inbox/
│   │       │   │   └── index.test.tsx
│   │       │   └── threads/
│   │       │       └── $id/
│   │       │           └── index.test.tsx
│   │       └── api/
│   │           └── data-deletion/
│   │               └── index.test.ts
│   ├── server/                   # ルート横断で再利用される server-only コード
│   │   ├── db/
│   │   │   ├── schema.ts         # Drizzle スキーマ（6 エンティティ：tenants, connected_pages, conversations, messages, ai_drafts, deletion_log）
│   │   │   ├── client.ts         # Supabase Pooler 接続（anon role + service role の 2 系統）
│   │   │   ├── with-tenant.ts    # withTenant(tenantId, fn) — `SET LOCAL app.tenant_id` を流す transaction ヘルパ
│   │   │   └── migrations/       # drizzle-kit が生成（RLS ポリシー含む）
│   │   ├── services/
│   │   │   ├── messenger.ts      # Send API ラッパー
│   │   │   ├── messenger.test.ts
│   │   │   ├── auth.ts           # Supabase Auth クライアント（signInWithPassword、signOut、JWT 検証、tenant_id 抽出）
│   │   │   ├── auth.test.ts
│   │   │   ├── crypto.ts         # AES-256-GCM encrypt/decrypt（Page Access Token 用）+ マスター鍵キャッシュ
│   │   │   ├── crypto.test.ts
│   │   │   └── ssm.ts            # SSM 取得共通ヘルパ（マスター鍵、Meta App Secret、Anthropic API キー等）
│   │   └── env.ts                # 環境変数スキーマ
│   └── styles/
├── tests/                        # ルート横断の統合・E2E
│   ├── integration/
│   │   ├── webhook-receive.test.ts    # Meta ペイロードの実形で流す（webhook → DB → SQS）
│   │   ├── ai-draft-worker.test.ts    # Worker Lambda：SQS event → Anthropic mock → ai_drafts insert
│   │   └── send-reply.test.ts         # 返信送信（thread route → Send API モック → DB）
│   └── e2e/
│       └── review-flow.spec.ts        # Playwright: ログイン→受信→下書き表示→編集→送信
├── drizzle.config.ts
├── package.json
└── tsconfig.json

webhook/                          # Webhook 受信専用 Lambda（独立ハンドラ）
├── src/
│   ├── handler.ts                # API Gateway イベント受信 → 署名検証 → DB INSERT → SQS enqueue → 200
│   ├── signature.ts              # X-Hub-Signature-256 検証
│   └── handler.test.ts
├── package.json                  # 最小依存（aws-sdk/sqs、postgres、drizzle-orm、zod）
└── tsconfig.json

ai-worker/                        # AI 下書き生成 Worker Lambda
├── src/
│   ├── handler.ts                # SQS Trigger → message_id 取得 → Anthropic API → ai_drafts INSERT
│   ├── prompt.ts                 # Claude Haiku 4.5 プロンプトテンプレート
│   └── handler.test.ts
├── package.json                  # 最小依存（@anthropic-ai/sdk、postgres、drizzle-orm）
└── tsconfig.json

keep-alive/                       # Supabase Pause 回避用 Lambda（FR-027）
├── src/
│   └── handler.ts                # SELECT 1 を Supabase に発行するだけ
├── package.json
└── tsconfig.json

terraform/                         # AWS インフラ定義（詳細は infrastructure.md）
├── bootstrap/                     # State 管理リソース（初回のみ、ローカル state）
├── modules/
│   ├── secrets/                   # SSM Parameter Store（パラメータ定義のみ）
│   ├── app-lambda/                # TanStack Start SSR Lambda + API Gateway（Lambda Web Adapter）
│   ├── webhook-lambda/            # Webhook 受信 Lambda + SQS enqueue 権限
│   ├── ai-worker-lambda/          # AI 下書き生成 Worker Lambda + SQS Trigger
│   ├── keep-alive-lambda/         # Supabase keep-alive Lambda + EventBridge Scheduled Rule
│   ├── queue/                     # SQS Queue + DLQ
│   ├── static-site/               # S3 + CloudFront（2 Origin 振り分け）+ ACM + Route53
│   ├── observability/             # CloudWatch アラーム + SNS 通知
│   └── github-actions-oidc/       # GitHub Actions 用 IAM Role（OIDC 認証）
└── envs/
    └── review/                    # 審査用環境
        ├── main.tf
        ├── variables.tf
        ├── providers.tf
        └── backend.tf

.github/
└── workflows/                     # CI/CD（詳細は R-011）
    ├── ci.yml                     # PR 時: lint + test + build
    ├── terraform-plan.yml         # PR 時（terraform/ 変更）: plan コメント
    ├── terraform-apply.yml        # main 後: 手動承認で apply
    ├── deploy-app.yml             # main 後: Lambda + S3 デプロイ
    └── e2e.yml                    # nightly E2E

docs/
├── review-submission/             # 審査提出用資料
│   ├── use-case-description.md    # 権限ごとの用途説明（英語、AI 下書き機能を主機能として記述）
│   ├── screencast-script.md       # スクリーンキャスト撮影台本
│   └── reviewer-credentials.md    # レビュワー用テストアカウント情報
└── operations/
    └── audit-runbook.md           # 審査期間中の監視・運用手順
```

**Structure Decision**: TanStack Start を中心に、独立 Lambda を 3 本（Webhook 受信 / AI Worker / keep-alive）追加する構成。コードベースは単一リポジトリだが**ビルド成果物とデプロイ先は機能別に分岐**する：

- `(public)` ルート → SSG で静的 HTML 生成 → S3 アップロード → CloudFront 配信
- `(auth)/login` → CSR で JS バンドル + HTML shell 生成 → S3 アップロード → CloudFront 配信
- `(app)` ルート + `api/data-deletion` ルート + `createServerFn` → **TanStack Start + Lambda Web Adapter** で SSR Lambda 化 → API Gateway 経由
- `webhook/` → Webhook 受信専用 Lambda（最小依存・最速応答）→ API Gateway の `/api/webhook` ルート経由
- `ai-worker/` → SQS Trigger Lambda（API Gateway 経由なし）
- `keep-alive/` → EventBridge Scheduled Rule Trigger Lambda

CloudFront は単一ディストリビューションで、パスパターンに応じて S3 Origin と API Gateway Origin を振り分ける（`/api/*`, `/_serverFn/*`, `/inbox*`, `/threads/*` → API Gateway、それ以外 → S3）。

**Lambda Web Adapter について**: TanStack Start の Node HTTP サーバ（`vinxi start` の Node ハンドラ）を Lambda 上でそのまま起動するための AWS 公式拡張。Lambda コンテナ起動時に Web Adapter が `0.0.0.0:8080` で TanStack Start サーバを立ち上げ、API Gateway イベントを HTTP リクエストに変換してルーティングする。これにより**ローカル `npm run dev` と本番 Lambda が同じ Node HTTP インタフェース**で動き、Lambda 専用ハンドラを書く必要がない。

**フロント構成はルート単位のコロケーションを採用する**：各ルートは `routes/<path>/index.tsx`（または `.ts`）をエントリとし、そのルート専用のコンポーネントを `-components/`、ルート専用のサーバーロジックを `-lib/` として同一ディレクトリに配置する。`-` prefix のファイル/ディレクトリは TanStack Router の `routeFileIgnorePrefix`（既定値 `-`）によってファイルベースルーティングから除外されるため、URL 空間を汚染せずに近接配置できる。複数ルートで再利用される server-only コード（DB クライアント / Supabase Auth / SSM トークン取得 / Send API ラッパー）のみ `app/src/server/` に残す。

**テスト配置は TanStack 公式「Test Router with File-Based Routing」ガイドに準拠**し、ルート単位のユニットテストは `app/src/test/routes/` に `app/src/routes/` をミラーする並行構造で配置する。ルート横断の統合テストと Playwright E2E のみ `app/tests/integration/`・`app/tests/e2e/` に集約する。Webhook Lambda / AI Worker / keep-alive のテストは各ディレクトリの `src/*.test.ts` でコロケーションする。

Terraform は `terraform/` にルート + モジュール構成で、審査用環境（`envs/review/`）のみ定義する。Phase 2 で AI 自動分類を追加する際は、`ai-worker/src/handler.ts` のプロンプトとレスポンス処理を拡張するだけで対応可能（Lambda 構造の変更不要）。

## Sprint 計画と User Story の対応

`research.md` R-011 の Sprint 分割は **CI 拡張の段階** を示すものであり、User Story の実装優先度とは別軸である。両者の対応関係を下表に明示する（どの Sprint でどの Story を実装するか）。

| Sprint | CI 拡張（R-011）| 実装する User Story | 主な成果物 |
|--------|----------------|---------------------|-----------|
| Sprint 1（W1） | vitest + eslint + tsc + terraform fmt/validate + build zip | （Walking Skeleton のみ）| Hello World ルート、健康チェック統合テスト 1 件 |
| Sprint 2（W1〜2）| terraform plan PR コメント | Story 1（一部）、Story 3 | `modules/secrets` / `queue` / Supabase プロジェクト作成、公開ページ 4 種（FR-012〜FR-015）、Supabase Auth 設定（FR-009）、login serverFn |
| Sprint 3（W2） | playwright E2E | Story 1（完結）、Story 2（一部）| Webhook 受信 Lambda（FR-001〜FR-004、FR-017）、SQS、受信一覧（FR-002）、E2E ログイン → 受信確認 |
| Sprint 4（W2〜3）| terraform apply 手動承認ゲート | Story 2（完結）、Story 4 | AI Worker Lambda + Anthropic 連携（FR-022〜FR-026）、Send API 送信（FR-005〜FR-008）、Page Access Token 警告（FR-018）、スクリーンキャスト台本ドラフト（FR-019）|
| Sprint 5（W3） | Lambda デプロイパイプライン | Story 4（完結）、Story 5 | 動画撮影 + 編集（AI 下書き → 人間承認の流れを明示）、Use Case 説明文（FR-020）、データ削除コールバック（FR-014、ai_drafts も削除対象）|
| Sprint 6（W3〜4）| 静的サイトビルド + S3 sync + CloudFront invalidation | 全 Story の審査リハーサル | FR-016（24/7 稼働）、FR-017（Webhook 20秒）、FR-021（テスト FB ページ）検証、CloudWatch アラーム + Supabase keep-alive 有効化、審査提出 |

**運用方針**:
- User Story の P1（Story 1〜4）は Sprint 5 終了までに全て実装完了。P2（Story 5）はドキュメント中心なので Sprint 5 で着手する。
- 各 Sprint 末に `quickstart.md` §6 の「審査提出前チェックリスト」を部分的に更新し、最終 Sprint 6 で全項目を埋める。
- Sprint 境界での Constitution Check（YAGNI / 単一責任 / テスト可能性）は毎 Sprint 末に実施する。

## Complexity Tracking

> `.specify/memory/constitution.md` が未ラティファイ（テンプレート）であるため、Constitution Check は暫定評価であり最終 PASS ではない。SQS + Worker Lambda の追加は Meta 20 秒 SLA + AI レイテンシの物理制約による必然で、複雑性の正当化のみ先行して明記する。
