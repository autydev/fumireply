# Infrastructure Design

**Feature**: MVP for Meta App Review Submission
**Branch**: `001-mvp-app-review`
**Date**: 2026-04-20
**Updated**: 2026-04-30 (architecture pivot: Supabase + Anthropic API、VPC/NAT/RDS Proxy/Cognito を廃止)
**IaC**: Terraform 1.6+
**Target Account**: Malbek 本番 AWS アカウント（`envs/review` ワークスペース）

本ドキュメントは `terraform/` 配下の設計書。各モジュールの責務、入出力、依存関係、コスト、セキュリティ設計を明文化する。

---

## 1. State 管理

### バックエンド構成

| リソース | 用途 | 名前 |
|----------|------|------|
| S3 バケット | State 本体の格納 | `malbek-terraform-state` |
| DynamoDB テーブル | 同時 apply 防止のロック | `malbek-terraform-locks` |
| KMS キー | State 暗号化 | alias `alias/terraform-state` |

S3 バケット設定：

- **Versioning 有効**（State の事故リカバリ用）
- **Server-side encryption**（KMS）
- **Public access block**（全面禁止）
- **Lifecycle**：非現行バージョンは 90 日後に削除

### Bootstrap 手順（State 管理基盤自体の作成）

Terraform 本編とは別に、**state 管理リソース自体を先に作る必要がある**。`terraform/bootstrap/` ディレクトリに最小構成を置き、ローカル state で一度だけ apply する：

```
terraform/bootstrap/
├── main.tf           # S3 バケット + DynamoDB + KMS
└── outputs.tf        # 本編が参照する名前群
```

bootstrap 完了後、本編 Terraform の `backend` ブロックで S3 バックエンドを指定する：

```hcl
terraform {
  backend "s3" {
    bucket         = "malbek-terraform-state"
    key            = "fumireply/review/terraform.tfstate"
    region         = "ap-northeast-1"
    dynamodb_table = "malbek-terraform-locks"
    encrypt        = true
  }
}
```

### State ファイル命名規則

`s3://malbek-terraform-state/<project>/<env>/terraform.tfstate`

- project：`fumireply`
- env：`review`（審査用）、将来 `prod`、`staging` を追加

---

## 2. 環境分離

### 方針

Terraform workspace は使わず、**ディレクトリ分離**で環境を管理する：

```
terraform/
├── bootstrap/                   # State 管理リソース（初回のみ）
├── modules/                     # 再利用モジュール
└── envs/
    └── review/                  # 審査用環境
        ├── main.tf              # モジュール呼び出し
        ├── variables.tf
        ├── terraform.tfvars     # envs ごとの値（gitignore 済み、SSM から取得 or 別管理）
        ├── providers.tf
        └── backend.tf
```

### Naming Convention

すべてのリソース名は以下のプレフィックスを付ける：

- 形式：`<project>-<env>-<resource-name>`
- 例：`fumireply-review-app-lambda`、`fumireply-review-webhook-lambda`、`fumireply-review-ai-worker`

Terraform 変数で統一：

```hcl
variable "name_prefix" {
  default = "fumireply-review"
}
```

タグも全リソースに統一付与：

```hcl
tags = {
  Project     = "fumireply"
  Environment = "review"
  ManagedBy   = "terraform"
  Feature     = "001-mvp-app-review"
}
```

---

## 3. モジュール一覧

**注**: 旧版にあった `networking`（VPC/NAT/Subnet）、`database`（RDS）、`auth`（Cognito）モジュールは廃止。DB は Supabase（AWS 外）、認証は Supabase Auth、Lambda は VPC 外配置に変更。

### 3.1 `modules/secrets`

**責務**: SSM Parameter Store のパラメータ定義（値は別途 CLI で投入、Terraform state には含めない）。

| パラメータ | 種別 | 用途 |
|-----------|------|------|
| `/fumireply/review/meta/app-secret` | SecureString | Meta App Secret（Webhook 署名検証用、Data Deletion 署名検証用）|
| `/fumireply/review/meta/page-access-token` | SecureString | 長期 Page Access Token |
| `/fumireply/review/meta/webhook-verify-token` | SecureString | Webhook 購読時の verify_token |
| `/fumireply/review/supabase/url` | SecureString | Supabase プロジェクト URL（例: `https://xxxx.supabase.co`）|
| `/fumireply/review/supabase/anon-key` | SecureString | Supabase Auth クライアント用 anon key |
| `/fumireply/review/supabase/service-role-key` | SecureString | Supabase Admin 操作用 service role key |
| `/fumireply/review/supabase/db-url` | SecureString | Supabase Pooler 接続文字列（`postgres://...pooler.supabase.com:6543/postgres`、Transaction mode）|
| `/fumireply/review/anthropic/api-key` | SecureString | Anthropic API キー（Worker Lambda 用）|
| `/fumireply/review/deletion-log/hash-salt` | SecureString | `deletion_log.psid_hash` の計算に使う 32 バイトランダム salt |

**Inputs**:
- `name_prefix`

**Outputs**:
- `ssm_path_prefix`（`/fumireply/review/`）

**設計上の注意**:
- Terraform は「パラメータが存在すること」だけを管理し、値は `lifecycle { ignore_changes = [value] }` で管理外にする。値の投入は `aws ssm put-parameter` で手動実施。
- Lambda の IAM ロールに `/fumireply/review/*` の読み取り権限を付与（Least-privilege）。
- **Secrets Manager は採用しない**：MVP では自動ローテーションが不要、SSM SecureString が無料で機能十分（R-005 の代替案検討で決定）。

---

### 3.2 `modules/queue`

**責務**: AI 下書き生成用の SQS キュー + Dead Letter Queue。

| リソース | 設定 |
|----------|------|
| SQS Queue（Standard）| `fumireply-review-ai-draft-queue`、Visibility Timeout 90 秒、Message Retention 4 日、ReceiveMessageWait 20 秒（long polling）|
| SQS Dead Letter Queue | `fumireply-review-ai-draft-dlq`、Message Retention 14 日 |
| Redrive Policy | `maxReceiveCount = 3`（3 回リトライで失敗したら DLQ へ）|

**Inputs**:
- `name_prefix`, `tags`

**Outputs**:
- `queue_url`
- `queue_arn`
- `dlq_arn`

**設計上の注意**:
- メッセージ本文は `{ messageId: string }` のみ（body 本体は DB から都度取得、SQS の payload に PII を載せない）。
- FIFO ではなく Standard で十分（受信 Lambda が `messages.id` で冪等化済み）。

---

### 3.3 `modules/app-lambda`

**責務**: TanStack Start SSR Lambda（Lambda Web Adapter 経由）+ API Gateway HTTP API。

| リソース | 設定 |
|----------|------|
| Lambda Function | `nodejs22.x`（24 が GA されていれば 24 に変更）、メモリ 1024MB、タイムアウト 30 秒、**VPC 外配置**、Lambda Web Adapter Layer を attach（`arn:aws:lambda:ap-northeast-1:753240598075:layer:LambdaAdapterLayerX86:<latest>`）|
| 環境変数 | `AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap`（Web Adapter）、`PORT=8080`、`NODE_ENV=production`、`SSM_PATH_PREFIX=/fumireply/review/` |
| IAM Role | SSM 読み取り（`/fumireply/review/*`）、CloudWatch Logs 書き込み、（VPC 関連権限なし）|
| API Gateway HTTP API | `/api/*`、`/_serverFn/*`、`/inbox*`、`/threads/*` のルーティング → Lambda Proxy 統合（`$default` route）|
| Lambda Permissions | API Gateway からの invoke 許可 |
| CloudWatch Log Group | 保持期間 30 日 |

**Inputs**:
- `name_prefix`, `tags`
- `ssm_path_prefix`
- `lambda_package_s3_bucket`, `lambda_package_s3_key`（デプロイ成果物の S3 URI）
- `web_adapter_layer_arn`（リージョン依存）

**Outputs**:
- `api_gateway_invoke_url`（CloudFront Origin として参照）
- `lambda_function_arn`
- `lambda_function_name`

**設計上の注意**:
- VPC に入れないため、外向き HTTPS（Supabase / Anthropic / Meta API）が NAT なしで素直に出る。
- コールドスタート対策として **Provisioned Concurrency は導入しない**（コスト増）。ただし審査期間中だけ最低 1 の Provisioned Concurrency を検討する運用オプションは残す。
- Web Adapter により TanStack Start は通常の Node HTTP サーバとして起動し、Lambda 専用ハンドラを書く必要がない。

---

### 3.4 `modules/webhook-lambda`

**責務**: Meta Webhook 受信専用 Lambda + API Gateway `/api/webhook` ルート。

| リソース | 設定 |
|----------|------|
| Lambda Function | `nodejs22.x`、メモリ 512MB、タイムアウト 10 秒、**VPC 外**、Web Adapter なし（API Gateway イベント直接ハンドリング）|
| 環境変数 | `SSM_PATH_PREFIX=/fumireply/review/`、`SQS_QUEUE_URL=<from queue module>` |
| IAM Role | SSM 読み取り、SQS `SendMessage`（特定キュー ARN 限定）、CloudWatch Logs |
| API Gateway Route | `GET /api/webhook`、`POST /api/webhook` → このLambda（`app-lambda` とは別 integration）|

**Inputs**:
- `name_prefix`, `tags`, `ssm_path_prefix`
- `sqs_queue_arn`, `sqs_queue_url`
- `api_gateway_id`（`app-lambda` モジュールから）

**Outputs**:
- `lambda_function_arn`

**設計上の注意**:
- 最小依存（`postgres`, `drizzle-orm`, `@aws-sdk/client-sqs`, `zod`）でコールドスタートを最小化。
- 処理: 署名検証 → DB INSERT（messages, conversations）→ SQS enqueue（`{ messageId }`）→ 200。AI 呼び出しは含めない。

---

### 3.5 `modules/ai-worker-lambda`

**責務**: AI 下書き生成 Worker Lambda。SQS Trigger で起動し、Anthropic API を呼んで `ai_drafts` を保存する。

| リソース | 設定 |
|----------|------|
| Lambda Function | `nodejs22.x`、メモリ 512MB、タイムアウト 60 秒、**VPC 外** |
| 環境変数 | `SSM_PATH_PREFIX=/fumireply/review/`、`ANTHROPIC_MODEL=claude-haiku-4-5-20251001` |
| IAM Role | SSM 読み取り、SQS `ReceiveMessage`/`DeleteMessage`/`GetQueueAttributes`、CloudWatch Logs |
| SQS Event Source Mapping | Batch Size 1（並列処理しやすく、1 件失敗が他に影響しない）|

**Inputs**:
- `name_prefix`, `tags`, `ssm_path_prefix`
- `sqs_queue_arn`

**Outputs**:
- `lambda_function_arn`

**設計上の注意**:
- Send API は呼ばない（FR-026 Human-in-the-Loop 必須）。`ai_drafts.body` に保存するだけ。
- Anthropic SDK の prompt caching を有効化してシステムプロンプトをキャッシュ（コスト削減）。

---

### 3.6 `modules/keep-alive-lambda`

**責務**: Supabase 無料プランの自動 Pause を回避するため、定期的に DB に SELECT 1 を発行する（FR-027）。

| リソース | 設定 |
|----------|------|
| Lambda Function | `nodejs22.x`、メモリ 256MB、タイムアウト 30 秒、**VPC 外** |
| 環境変数 | `SSM_PATH_PREFIX=/fumireply/review/` |
| IAM Role | SSM 読み取り（DB URL 取得用）、CloudWatch Logs |
| EventBridge Scheduled Rule | `rate(6 days)` で起動（Supabase の 7 日 Pause 閾値より短く）|
| EventBridge Target | Lambda Function（Permission 設定）|

**Inputs**:
- `name_prefix`, `tags`, `ssm_path_prefix`

**Outputs**:
- `lambda_function_arn`
- `event_rule_arn`

**設計上の注意**:
- 失敗時は CloudWatch Alarm で通知（observability モジュールに含める）。連続失敗で Pause 発動 → 審査差し戻しの致命的リスクのため監視必須。

---

### 3.7 `modules/static-site`

**責務**: S3 バケット + CloudFront Distribution + ACM 証明書 + Route53 レコード。

| リソース | 設定 |
|----------|------|
| S3 Bucket | 静的ファイル格納、パブリックアクセス禁止、Origin Access Control 経由のみ許可 |
| CloudFront Distribution | 2 Origin（S3 / API Gateway）、SSL 証明書（ACM us-east-1）、独自ドメイン連携 |
| CloudFront OAC | S3 を CloudFront 専用アクセスに絞る |
| ACM Certificate (us-east-1) | `review.malbek.co.jp` + `malbek.co.jp` |
| Route53 Record | A (ALIAS) → CloudFront |
| CloudFront Cache Policy | 静的ファイル用（長期キャッシュ）、動的ルート用（キャッシュ無効）|
| CloudFront Origin Request Policy | 動的ルート向けに全ヘッダー + クエリ + Cookie を pass through |

**Inputs**:
- `name_prefix`, `tags`
- `domain_name`（`review.malbek.co.jp` or `malbek.co.jp`）
- `api_gateway_invoke_url`（app-lambda モジュールから）
- `route53_zone_id`

**Outputs**:
- `cloudfront_distribution_id`
- `cloudfront_domain_name`
- `s3_bucket_name`（デプロイスクリプトが sync 先として使う）

**Behavior 設定（パスパターンごとの Origin 振り分け）**:

| パスパターン | Origin | キャッシュ |
|-------------|--------|-----------|
| `/api/*`、`/_serverFn/*` | API Gateway | なし（TTL=0） |
| `/inbox*`, `/threads/*` | API Gateway | なし |
| `/_build/*`, `/assets/*` | S3 | 長期（TTL=1年、immutable） |
| `/login` | S3（CSR の HTML shell + JS bundle）| 短期 |
| `/`（デフォルト含む `/privacy`, `/terms`, `/data-deletion`, `/data-deletion-status/*`）| S3 | 短期（TTL=5分、HTML 用） |

**設計上の注意**:
- ACM 証明書は CloudFront が **us-east-1 限定**で参照するため、プロバイダを分ける必要あり：
  ```hcl
  provider "aws" {
    alias  = "us_east_1"
    region = "us-east-1"
  }
  ```
- CloudFront の invalidation はデプロイスクリプトで実行（Terraform では扱わない）。

---

### 3.8 `modules/observability`

**責務**: CloudWatch アラーム + SNS トピック + 通知設定（R-009）。

| リソース | 用途 |
|----------|------|
| SNS Topic | アラート通知宛先 |
| SNS Subscription | Malbek メール（+ 将来 Slack Incoming Webhook）|
| CloudWatch Alarm | (a) app-lambda Error Rate > 1%、(b) webhook-lambda Error Rate > 0.5%、(c) ai-worker DLQ Approximate Message Visible > 0、(d) ai-worker Duration p95 > 30s、(e) keep-alive 失敗 |
| CloudWatch Dashboard | Lambda 呼び出し数、Webhook 成功率、AI Worker 成功率、Supabase keep-alive 成功記録 |

**Inputs**:
- `name_prefix`, `tags`
- `app_lambda_function_name`
- `webhook_lambda_function_name`
- `ai_worker_lambda_function_name`
- `keep_alive_lambda_function_name`
- `ai_draft_dlq_arn`
- `api_gateway_id`
- `alert_email`

**Outputs**:
- `sns_topic_arn`

**設計上の注意**:
- アラームのしきい値は審査期間中と平常時で変える想定（envs/review では厳しめ）。
- DLQ にメッセージが入ったら即時通知 → Anthropic API 障害や Supabase 接続エラーの早期検知。

---

### 3.9 `modules/github-actions-oidc`

GitHub Actions 用の IAM OIDC Provider + Role。詳細は旧版と同じ（`terraform plan/apply`、Lambda update-function-code、S3 sync、CloudFront invalidation の権限を付与）。

---

## 4. モジュール依存グラフ

```
              ┌──────────────┐
              │   secrets    │
              │ (SSM only)   │
              └──────┬───────┘
                     │ ssm_path_prefix
        ┌────────────┼────────────────────┐
        ▼            ▼                    ▼
   ┌─────────┐  ┌─────────────┐  ┌──────────────────┐
   │ app-    │  │ webhook-    │  │ ai-worker-       │
   │ lambda  │  │ lambda      │  │ lambda           │
   └────┬────┘  └─────┬───────┘  └────────┬─────────┘
        │             │                    ▲
        │             │                    │ SQS Trigger
        │             ▼                    │
        │       ┌──────────┐               │
        │       │  queue   │───────────────┘
        │       │ SQS+DLQ  │
        │       └──────────┘
        │
        │ api_gateway_invoke_url
        ▼
   ┌──────────────┐
   │ static-site  │
   │ (S3+CloudF)  │
   └──────────────┘

   ┌──────────────────┐         ┌────────────────┐
   │ keep-alive-      │←────────│ EventBridge    │
   │ lambda           │ Trigger │ rate(6 days)   │
   └──────────────────┘         └────────────────┘

   ┌──────────────┐
   │observability │  ← 全 Lambda + DLQ + API GW を監視
   └──────────────┘
```

**Apply 順序**:

1. `bootstrap/`（state リソース作成、1 回のみ）
2. Supabase プロジェクト作成（外部、Terraform 管理外）→ DB URL を SSM に手動投入
3. `envs/review/`（一括 apply：Terraform が依存関係を自動解決）

---

## 5. モジュール入出力契約（variables/outputs 概要）

各モジュールの `variables.tf` / `outputs.tf` が「インフラの契約」となる。実装時は以下を遵守：

- **Inputs**：必ず `description` と `type` を明記、デフォルト値がある場合は `default`、Sensitive な値は `sensitive = true`
- **Outputs**：下流モジュールが参照する値のみ出力、不要な値は出さない
- **契約の変更**：モジュールの Outputs 名を変更する場合は、下流モジュールの参照を同一 PR で修正する

各モジュールの詳細な variables / outputs は実装時に `modules/<name>/README.md` に記載する（Terraform docs の自動生成を推奨）。

---

## 6. デプロイフロー

### 6.1 インフラ変更（Terraform）

```
開発者の PR
  ↓
GitHub Actions: terraform plan（PR にコメント投稿）
  ↓
レビュー承認 → main にマージ
  ↓
GitHub Actions: 手動承認ゲート（environment protection）
  ↓
terraform apply（envs/review）
```

**原則**:
- `terraform apply` は CI 経由のみ（ローカル apply は禁止、緊急時の例外を除く）
- `main` マージ後も自動 apply はしない（手動承認ゲート必須）
- Bootstrap だけは例外：初回のみローカル apply

### 6.2 アプリケーション変更（Lambda コード）

```
開発者の PR
  ↓
GitHub Actions: lint + test + build + Terraform plan
  ↓
レビュー承認 → main にマージ
  ↓
GitHub Actions:
  1. npm ci + npm run build (app, webhook, ai-worker, keep-alive それぞれ)
  2. zip → S3 にアップロード（4 つの Lambda パッケージ）
  3. aws lambda update-function-code × 4
  4. 静的ファイル → S3 sync（static-site 用、SSG + CSR 出力）
  5. CloudFront invalidation（`/*`）
  6. DB マイグレーション（必要時のみ、手動承認後）
```

**原則**:
- 4 つの Lambda は同一パイプラインで同時更新（整合性確保）
- DB マイグレーションは **手動承認ゲート**の後ろ（自動実行しない）

### 6.3 初回デプロイ手順

詳細は [`quickstart.md`](./quickstart.md)。要点：

1. Bootstrap apply（State 管理リソース）
2. Supabase プロジェクト作成（東京リージョン、無料プラン）→ DB URL / anon key / service role key を取得
3. `secrets` モジュール apply → SSM パラメータ定義作成
4. CLI で SSM に実値を手動投入（Meta App Secret、Page Access Token、Supabase URL/Keys、Anthropic API Key）
5. `envs/review` を全モジュール apply
6. Supabase ダッシュボードでテストユーザー作成（`operator@malbek.co.jp` / `reviewer@malbek.co.jp`）
7. 初回 Lambda デプロイ（GitHub Actions or 手動）
8. 初回 DB マイグレーション

---

## 7. コスト試算（MVP 版・月額）

旧版（VPC + RDS + NAT + Cognito）から大幅にスリム化：

| サービス | 想定月額 | 備考 |
|----------|---------|------|
| Lambda（app + webhook + ai-worker + keep-alive）| 〜$0 | 100万リクエスト/月の無料枠内 |
| API Gateway HTTP API | 〜$0〜1 | 100万リクエスト/月 $1 |
| **Supabase Free** | **$0** | 500MB DB / 50,000 MAU / 2GB ファイル無料 |
| **Anthropic API（Claude Haiku 4.5）** | **〜$1〜3** | 日 30 件・1 件 ~2KB 入力 / ~500 byte 出力想定 |
| CloudFront | 〜$0〜1 | 1TB 配信/月の無料枠内 |
| S3 | 〜$0.5 | SSG 成果物 + Lambda パッケージ数MB |
| SQS | 〜$0 | 100万リクエスト/月の無料枠内 |
| EventBridge | 〜$0 | 14M イベント/月の無料枠内 |
| SSM Parameter Store | 〜$0 | Standard Tier 無料 |
| CloudWatch Logs + アラーム | 〜$1〜3 | |
| **合計** | **〜$2〜8/月** | 旧版（〜$45-65）から大幅削減 |

**廃止したコスト要因**:
- NAT Gateway（〜$32）→ Lambda VPC 外配置で不要
- VPC Endpoints（〜$8）→ VPC 廃止で不要
- RDS（〜$15-20）→ Supabase 無料枠
- Cognito → MVP では Supabase Auth に統合

**注意点**:
- Supabase 無料プラン超過（500MB DB / 50,000 MAU 等）したら Pro プラン $25/月にアップグレード必要。MVP 規模では発生しない見込み。
- Anthropic API はトークン量で従量課金。1 メッセージあたり ~$0.001〜0.005 想定。

---

## 8. セキュリティ設計

### 8.1 IAM（Least-privilege）

各 Lambda 実行ロールの権限：

**app-lambda**:
- `ssm:GetParameter` — `arn:aws:ssm:*:*:parameter/fumireply/review/*` 限定
- `logs:CreateLogStream`, `logs:PutLogEvents` — 自身の Log Group 限定

**webhook-lambda**:
- `ssm:GetParameter` — 同上
- `sqs:SendMessage` — 特定 Queue ARN 限定
- `logs:*` — 自身の Log Group 限定

**ai-worker-lambda**:
- `ssm:GetParameter` — 同上
- `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` — 特定 Queue ARN 限定
- `logs:*` — 自身の Log Group 限定

**keep-alive-lambda**:
- `ssm:GetParameter` — 同上（DB URL 取得のみ）
- `logs:*`

**絶対に与えない権限**:
- `*` リソースへの `s3:*`（CloudFront OAC で S3 を CloudFront 専用にする）
- `iam:*`（Lambda から IAM 操作は不要）
- `ec2:*`（VPC 不使用なので不要）

### 8.2 Secrets 管理

- **平文で DB / Git に置かない**：Meta トークン、Supabase Service Role Key、Anthropic API Key
- **Terraform state に含めない**：値は SSM 経由で参照、`lifecycle { ignore_changes = [value] }` で管理外
- **Lambda 環境変数に Secret を入れない**：SSM から起動時に取得、メモリキャッシュ

### 8.3 ネットワーク

- **VPC は使わない**：Lambda はすべて VPC 外配置。
- Supabase Postgres は Supabase 側で SSL 必須 + Connection Pooler 経由のみアクセス可能（Pooler は IP allowlist デフォルト全開放、強力なパスワード + SSL で防御）。
- API Gateway は public だが、認証（Supabase JWT）と Webhook 署名検証で保護。
- S3 バケットは public access block、CloudFront OAC 経由のみアクセス可。

### 8.4 暗号化

- **保存時**：Supabase（AES-256 自動）、S3（SSE-S3 または KMS）、SSM（SecureString + KMS）、Terraform state（KMS）
- **転送時**：すべて HTTPS（ACM 証明書）、Supabase 接続は SSL 強制

### 8.5 監査

- CloudTrail は AWS アカウント全体で有効化（本プロジェクト外で設定済み想定）
- Supabase のログイン監査ログは Supabase ダッシュボード（Auth Logs）で確認

### 8.6 レビュワーアカウントの補償統制

2FA・IP 制限なし + パスワード固定 + 申請フォームへの認証情報記載 という Meta App Review 要件のため、通常のセキュリティ管理水準を下げる運用となる。これを補償するため、以下の統制を実装する：

#### 8.6.1 時限的な有効化

- 平常時は `reviewer@malbek.co.jp` を Supabase Auth で `banned_until` を未来日にして無効化
- 審査提出の直前に有効化
- 審査結果通知（承認／却下）を受けて**24 時間以内に再度無効化**
- 無効化時はパスワードも Supabase ダッシュボードで再生成し SSM に記録

#### 8.6.2 サインインイベントの通知

- Supabase Auth Logs を定期的に確認（Webhook で CloudWatch に転送する Phase 2 機能は任意）
- MVP では「審査期間中はオペレーターが Supabase ダッシュボードを 1 日 1 回確認する」運用

#### 8.6.3 期間ログの保管

- reviewer アカウントの全活動ログ（Supabase Auth Logs + アプリ側構造化ログ）を **1 年間保持**
- アプリ側ログ（CloudWatch Logs）は Log Group の保持期間を 365 日に設定

#### 運用手順

上記 8.6.1〜8.6.3 の具体的な操作手順は `docs/operations/audit-runbook.md` に記載する（MVP 実装時に作成）。

---

## 9. 運用上の注意点

### 9.1 審査期間中の固定事項

- **Supabase プロジェクトを Pause しない**（keep-alive Lambda が機能していることを毎日確認）
- Lambda 関数を**削除しない**
- CloudFront Distribution を**無効化しない**
- Supabase reviewer パスワードを**変更しない**

### 9.2 災害時の復旧順序（DR）

1. Supabase ダッシュボードから自動バックアップで復元（無料プランは Point-in-Time Recovery なし、Pro 以上で利用可。MVP では日次手動 `pg_dump` を audit-runbook に組み込む）
2. Terraform apply で他リソース再作成
3. Lambda コードを再デプロイ（4 関数）
4. 静的ファイルを S3 に再 sync
5. CloudFront invalidation

RTO 目標：**4 時間以内**（審査期間中のダウンタイムは極力避ける）。

### 9.3 定期タスク

- 日次：Supabase keep-alive Lambda の最終成功時刻を CloudWatch で確認
- 月次：Meta Page Access Token の有効性確認（ローテーション不要だが念のため）
- 月次：AWS / Anthropic / Supabase コスト確認
- 四半期：不要リソースの棚卸し

詳細は `docs/operations/audit-runbook.md` に記載する。

---

## 10. Phase 2 以降の拡張方針

| 追加する機能 | 新規 or 既存モジュール変更 |
|-------------|-----------------------------|
| AI 自動分類（カテゴリタグ付け）| `ai-worker-lambda` の prompt と DB スキーマ拡張のみ |
| Instagram DM 連携 | `webhook-lambda` の payload 解析を拡張、`app-lambda` の IAM は変更なし |
| Slack 通知 | `modules/slack-notifier-lambda` 新規追加（SQS Trigger or EventBridge）|
| マルチテナント | `data-model.md` に `tenants` 追加、Drizzle スキーマと middleware で tenant_id を引き回す |
| Supabase Pro へのアップグレード | Supabase ダッシュボードで実施、Terraform 変更なし |
| RDS への移行（AWS 統一性が必要になったら）| `modules/database` を新規追加、Drizzle スキーマ流用、接続先のみ変更 |

いずれも**既存モジュールを大きく変更せず、新規モジュール追加で拡張できる**ように境界を設計している。

---

## 関連ドキュメント

- [`plan.md`](./plan.md) — 実装プラン全体
- [`research.md`](./research.md) — 技術選定の根拠（R-002 認証、R-010 ルート別レンダリング、R-012 Supabase 採用 等）
- [`quickstart.md`](./quickstart.md) — 初回セットアップ手順
- [`data-model.md`](./data-model.md) — DB スキーマ
- [`contracts/`](./contracts/) — 外部 API / 内部 API の契約
