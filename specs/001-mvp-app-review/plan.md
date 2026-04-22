# Implementation Plan: MVP for Meta App Review Submission

**Branch**: `001-mvp-app-review` | **Date**: 2026-04-20 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-mvp-app-review/spec.md`

## Summary

Meta App Review 通過に必要な最小機能（Messenger 受信 → 管理画面で確認・編集 → Send API で返信）を実装する。design v2 の目的地である TanStack Start + AWS 構成の延長上に MVP を構築する。

**アーキテクチャ要点**（詳細は research.md / infrastructure.md）:
- TanStack Start モノリスをルート別に SSG / CSR / SSR で出し分け（R-010）。公開ページは S3 + CloudFront、管理画面と API は単一 Lambda。
- 認証は Cognito User Pool + JWT HttpOnly Cookie（DB セッション不使用、R-002）。
- Webhook 分離は MVP 段階では行わず、Phase 2 にトリガー条件付きで保留（R-001）。
- 実装 1 週目で CI（GitHub Actions）を Walking Skeleton として構築し、PR でテストと Terraform plan が自動検証される状態を先に作る（R-011）。

AI 分類 Lambda / SQS / Instagram DM / Slack 通知 / 顧客管理 / 商品管理は MVP Out of Scope（spec.md）。審査通過後に同一 App ID 配下で段階的に追加する。

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 20.x (AWS Lambda ランタイム `nodejs20.x`)
**Package Manager**: npm（lockfile = `package-lock.json`）。pnpm / yarn は使用しない。CI は `npm ci` でインストールし、lockfile の更新は PR 内で `npm install` を実行した結果のみをコミットする。

**HTTP クライアント方針**: Meta Graph API / Send API / Data Deletion Callback 等の外部 HTTP 呼び出しは、**グローバル `fetch`（Node.js 20 native / WHATWG Fetch）で実装する**。`axios` および axios ラッパーの新規導入は禁止（最近の脆弱性報告により依存を避ける運用判断）。タイムアウトは `AbortSignal.timeout(ms)`、リトライは自前ヘルパで指数バックオフを実装する（`contracts/meta-send-api.md` §Retry Strategy に従う）。ラッパーが必要になった場合のみ `ky` / `ofetch` 等の fetch 互換軽量ライブラリに限定する。
**Primary Dependencies**:
- `@tanstack/react-start` — SSR + `createServerFn` でフロント API を兼務
- `drizzle-orm` + `postgres` — 型安全な Postgres アクセス、Lambda 最適化
- `@aws-sdk/client-cognito-identity-provider` — Cognito `InitiateAuth` / `GlobalSignOut` 呼び出し
- `aws-jwt-verify` — Cognito が発行する JWT（ID Token / Refresh Token）の署名検証、JWKS 自動キャッシュ
- `zod` — Webhook ペイロードと API 入出力の検証
- `@aws-sdk/client-ssm` — Page Access Token 等のシークレット取得

**Infrastructure**: Terraform 1.6+（S3 バックエンド + DynamoDB ロック）。詳細なモジュール設計・依存関係・コスト試算・セキュリティ設計は [`infrastructure.md`](./infrastructure.md) を参照。

**Storage**: AWS RDS Postgres `db.t4g.micro`（無料枠）。全テーブルを単一インスタンスに格納。接続は VPC 内 Lambda から直接（RDS Proxy は MVP では省略）。

**Testing & CI**:
- **CI First（Walking Skeleton）**：実装 1 週目で GitHub Actions を先に構築し、空のアプリ + テスト 1 件が PR で自動検証される状態を作る（詳細は R-011）。機能追加は CI 稼働後から。
- `vitest` — ユニット + 統合テスト（Webhook 署名検証、Send API モック、DB マイグレーション適用後の CRUD）
- `playwright` — 受信 → 返信送信の E2E スモーク（ローカル + プレビュー環境）
- Meta 側の実機疎通は手動スモーク（テスト FB ページ + Messenger アプリ）
- Terraform：`terraform fmt -check` + `validate` + PR 上で `plan` 結果をコメント投稿
- AWS 認証：GitHub Actions は OIDC ベースの IAM Role 引き受け（長期アクセスキー不使用）

**Target Platform**: AWS Lambda + API Gateway（HTTP API）+ RDS + Cognito User Pool + S3/CloudFront（静的生成ページ配信）。独自ドメイン配下に CloudFront 経由で配信。

**Project Type**: Web application — TanStack Start モノリス 1 本。ルート単位で**レンダリング戦略を使い分ける**（詳細は R-010 参照）：

| ルート | モード | ホスティング | 理由 |
|--------|--------|--------------|------|
| `/`（会社情報）、`/privacy`、`/terms`、`/data-deletion` | **SSG**（ビルド時静的生成）| S3 + CloudFront | 静的コンテンツ、審査必須ページ、ダウンタイム耐性を最優先 |
| `/login` | **CSR**（クライアントレンダリング）| S3 + CloudFront | 認証前でレンダリング対象データなし、Lambda 不要 |
| `/inbox`, `/threads/$id` | **SSR** | Lambda | 認証チェック + データフェッチを統合、初期表示を速く |
| `/api/webhook`, `/api/data-deletion`, `createServerFn` 全般 | **Server-only** | Lambda | API / Webhook 処理 |

**Performance Goals**:
- Webhook Lambda のコールドスタート + 処理時間で p95 < 5 秒、p99 < 15 秒（Meta の 20 秒 SLA に十分なマージン）
- 公開ページ（SSG）初期表示 p95 < 500ms（CloudFront エッジキャッシュから配信）
- 管理画面（SSR）初期表示 p95 < 3 秒（CloudFront キャッシュ + Lambda ウォーム時）
- Send API 呼び出しは p95 < 3 秒で応答

**Constraints**:
- **Meta Webhook は 20 秒以内に 200 必須**：MVP では同期処理（署名検証 → DB insert → 200）で収まる見込みだが、処理時間が 10 秒を超えるようなら Phase 2 で SQS 分離する ADR 条項を発動する。
- **HTTPS 必須**：API Gateway のデフォルト証明書 or ACM 証明書 + CloudFront で独自ドメイン配下を HTTPS 化。
- **24/7 稼働**：Lambda は常時起動不要（オンデマンド）だが、RDS は常時稼働。審査期間中は RDS を停止しない運用ルールを設ける。
- **Page Access Token の長期化**：Meta Graph API で `fb_exchange_token` を介して長期トークン化し SSM Parameter Store に格納。
- **ユーザー認証**：Cognito User Pool 管理。DB にユーザーテーブル／セッションテーブルを持たず、JWT を HttpOnly Cookie で扱うステートレスセッション。

**Scale/Scope**:
- 想定アクセス：審査期間中のレビュワー 1〜2 名 + 自社オペレーター 1 名 = **同時ユーザー 3 名程度**
- 想定メッセージ数：審査中の手動テストで 1 日 10〜30 件程度
- 画面数：管理画面 2 画面（受信一覧、スレッド詳細）+ ログイン画面 + 公開ページ 4 種（プライバシー、利用規約、データ削除、会社情報）= 7 画面
- LOC 目安：~2000 行（バックエンドサービス含む）

## Constitution Check

*GATE: Phase 0 研究の前に必ずパス、Phase 1 設計後に再チェック。*

**プロジェクト憲法の状態**: `.specify/memory/constitution.md` は未ラティファイ（テンプレートのまま）。本プランでは業界標準のゲートを暫定適用する：

| ゲート | 判定 | 根拠 |
|--------|------|------|
| **YAGNI（不要機能を入れない）** | ✅ PASS | 仕様の Out of Scope を厳守。AI 分類、Instagram DM、Slack 通知、顧客管理、商品管理、マルチテナント、トーン設定はすべて除外済み。 |
| **単一責任（1 機能 1 ストーリー）** | ✅ PASS | User Story 1〜5 が独立テスト可能で、それぞれ独立にデモできる。 |
| **テスト可能性** | ✅ PASS | Webhook 署名検証・送信ロジック・認証はユニットテスト可能。受信→送信フローは E2E で検証可能。 |
| **シンプル優先（Lambda 3 本 → 1 本に集約）** | ✅ PASS | MVP 規模では Webhook 分離不要。ADR-002 のトリガー条件（Meta Webhook 20 秒制約）は同期処理で十分満たせる。複雑さの正当化は不要。 |
| **観測性** | ✅ PASS | CloudWatch Logs に構造化ログ出力。Webhook 受信・送信成功/失敗・署名検証失敗をすべて記録。 |
| **可逆性（Phase 2 への移行容易性）** | ✅ PASS | TanStack Start の route を分離するだけで Webhook Lambda を独立 Lambda に切り出し可能。DB スキーマは Phase 2 と共通。 |

**複雑性の正当化**: なし（Complexity Tracking セクションは空で提出）。

## Project Structure

### Documentation (this feature)

```text
specs/001-mvp-app-review/
├── spec.md              # 仕様書（作成済み）
├── plan.md              # 本ファイル
├── research.md          # Phase 0 成果物（技術選定ログ）
├── data-model.md        # Phase 1 成果物（DB スキーマ）
├── infrastructure.md    # Phase 1 成果物（Terraform モジュール設計 + CI/CD + コスト）
├── quickstart.md        # Phase 1 成果物（セットアップ手順）
├── contracts/           # Phase 1 成果物（API 契約）
│   ├── meta-webhook.md
│   ├── meta-send-api.md
│   ├── data-deletion-callback.md
│   └── admin-api.md
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
│   │   │           ├── index.tsx       # スレッド詳細 + 返信送信
│   │   │           └── -components/
│   │   │               ├── ThreadMessages.tsx
│   │   │               └── ReplyForm.tsx
│   │   └── api/                  # Server-only → Lambda
│   │       ├── webhook/
│   │       │   ├── index.ts            # Meta Webhook（GET 検証 + POST 受信）
│   │       │   └── -lib/               # このルート専用ロジック
│   │       │       ├── signature.ts    # X-Hub-Signature-256 検証
│   │       │       ├── signature.test.ts
│   │       │       └── idempotency.ts  # meta_message_id 冪等挿入
│   │       └── data-deletion/
│   │           └── index.ts            # Meta データ削除コールバック
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
│   │           ├── webhook/
│   │           │   └── index.test.ts
│   │           └── data-deletion/
│   │               └── index.test.ts
│   ├── server/                   # ルート横断で再利用される server-only コード
│   │   ├── db/
│   │   │   ├── schema.ts         # Drizzle スキーマ（4 エンティティ）
│   │   │   ├── client.ts         # 接続プール
│   │   │   └── migrations/       # drizzle-kit が生成
│   │   ├── services/             # 非ルートファイルは素直にコロケーションでテスト配置
│   │   │   ├── messenger.ts      # Send API ラッパー（Phase 2 の分類 Lambda でも再利用）
│   │   │   ├── messenger.test.ts
│   │   │   ├── auth.ts           # Cognito InitiateAuth / GlobalSignOut + JWT 検証
│   │   │   ├── auth.test.ts
│   │   │   └── token.ts          # Page Access Token 取得（SSM）
│   │   └── env.ts                # 環境変数スキーマ
│   └── styles/
├── tests/                        # ルート横断の統合・E2E
│   ├── integration/
│   │   ├── webhook-receive.test.ts    # Meta ペイロードの実形で流す（webhook → DB）
│   │   └── send-reply.test.ts         # 返信送信（thread route → Send API モック → DB）
│   └── e2e/
│       └── review-flow.spec.ts        # Playwright: ログイン→受信→返信
├── drizzle.config.ts
├── package.json
└── tsconfig.json

terraform/                         # AWS インフラ定義（詳細は infrastructure.md）
├── bootstrap/                     # State 管理リソース（初回のみ、ローカル state）
├── modules/
│   ├── networking/                # VPC + Subnet + NAT + VPC Endpoints + SG
│   ├── database/                  # RDS Postgres + セキュリティグループ
│   ├── auth/                      # Cognito User Pool + App Client + Groups + 初期ユーザー
│   ├── secrets/                   # SSM Parameter Store（パラメータ定義のみ）
│   ├── app-lambda/                # TanStack Start SSR Lambda + API Gateway
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
│   ├── use-case-description.md    # 権限ごとの用途説明（英語）
│   ├── screencast-script.md       # スクリーンキャスト撮影台本
│   └── reviewer-credentials.md    # レビュワー用テストアカウント情報
└── operations/
    └── audit-runbook.md           # 審査期間中の監視・運用手順
```

**Structure Decision**: TanStack Start モノリスで 1 アプリ構成。コードベースは単一だが**ビルド成果物とデプロイ先はルート種別で分岐**する（R-010）：

- `(public)` ルート → SSG で静的 HTML 生成 → S3 アップロード → CloudFront 配信
- `(auth)/login` → CSR で JS バンドル + HTML shell 生成 → S3 アップロード → CloudFront 配信
- `(app)` ルート + `api` ルート + `createServerFn` → Lambda ハンドラとしてビルド → API Gateway 経由

CloudFront は単一ディストリビューションで、パスパターンに応じて S3 Origin と API Gateway Origin を振り分ける（`/api/*`, `/inbox*`, `/threads/*` → API Gateway、それ以外 → S3）。

**フロント構成はルート単位のコロケーションを採用する**：各ルートは `routes/<path>/index.tsx`（または `.ts`）をエントリとし、そのルート専用のコンポーネントを `-components/`、ルート専用のサーバーロジックを `-lib/` として同一ディレクトリに配置する。`-` prefix のファイル/ディレクトリは TanStack Router の `routeFileIgnorePrefix`（既定値 `-`）によってファイルベースルーティングから除外されるため、URL 空間を汚染せずに近接配置できる。複数ルートで再利用される server-only コード（DB クライアント / Cognito 認証 / SSM トークン取得 / Send API ラッパー）のみ `src/server/` に残す（`messenger.ts` は Phase 2 の分類 Lambda でも再利用する想定のため横断層に置く）。

**テスト配置は TanStack 公式「Test Router with File-Based Routing」ガイドに準拠**し、ルート単位のユニットテストは `src/test/routes/` に `src/routes/` をミラーする並行構造で配置する（`src/test/setup.ts`・`src/test/file-route-utils.tsx` も公式例に従って設置）。これによりルートの URL ツリーとテストツリーが同型で保たれ、テストコードがルート生成や型生成に影響しない。一方、ルート配下の `-lib/` や `src/server/services/` のような**非ルートファイル**はテストをコロケーション（`.test.ts` を実体の隣）して構わない（ルート化の対象外であり、Vitest のデフォルトで解決できるため）。ルート横断の統合テストと Playwright E2E のみ `app/tests/integration/`・`app/tests/e2e/` に集約する。

Terraform は `terraform/` にルート + モジュール構成で、審査用環境（`envs/review/`）のみ定義する。Phase 2 で Webhook を別 Lambda に分離する際は、`app/src/routes/api/webhook/` ディレクトリ一式（ルート本体 + `-lib/` の signature / idempotency）を独立 Lambda に複製 → API Gateway のルーティングを分離、という移行パス。

## Sprint 計画と User Story の対応

`research.md` R-011 の Sprint 分割は **CI 拡張の段階** を示すものであり、User Story の実装優先度とは別軸である。両者の対応関係を下表に明示する（どの Sprint でどの Story を実装するか）。

| Sprint | CI 拡張（R-011）| 実装する User Story | 主な成果物 |
|--------|----------------|---------------------|-----------|
| Sprint 1（W1） | vitest + eslint + tsc + terraform fmt/validate + build zip | （Walking Skeleton のみ）| Hello World ルート、健康チェック統合テスト 1 件 |
| Sprint 2（W1〜2）| terraform plan PR コメント | Story 1（一部）、Story 3 | `modules/networking` / `database` / `auth` / `secrets` の Terraform apply、公開ページ 4 種（FR-012〜FR-015）、Cognito 認証（FR-009）、login serverFn |
| Sprint 3（W2） | playwright E2E | Story 1（完結）、Story 2（一部）| Webhook 受信（FR-001〜FR-004）、受信一覧（FR-002）、スレッド表示、E2E ログイン → 受信確認 |
| Sprint 4（W2〜3）| terraform apply 手動承認ゲート | Story 2（完結）、Story 4 | Send API 送信（FR-005〜FR-008）、Page Access Token 警告（FR-018）、スクリーンキャスト台本ドラフト（FR-019）|
| Sprint 5（W3） | Lambda デプロイパイプライン | Story 4（完結）、Story 5 | 動画撮影 + 編集、Use Case 説明文（FR-020）、データ削除コールバック（FR-014）|
| Sprint 6（W3〜4）| 静的サイトビルド + S3 sync + CloudFront invalidation | 全 Story の審査リハーサル | FR-016（24/7 稼働）、FR-017（Webhook 20秒）、FR-021（テスト FB ページ）検証、CloudWatch アラーム有効化、審査提出 |

**運用方針**:
- User Story の P1（Story 1〜4）は Sprint 5 終了までに全て実装完了。P2（Story 5）はドキュメント中心なので Sprint 5 で着手する。
- 各 Sprint 末に `quickstart.md` §6 の「審査提出前チェックリスト」を部分的に更新し、最終 Sprint 6 で全項目を埋める。
- Sprint 境界での Constitution Check（YAGNI / 単一責任 / テスト可能性）は毎 Sprint 末に実施する。

## Complexity Tracking

> Constitution Check で違反なし。本セクションは空。
