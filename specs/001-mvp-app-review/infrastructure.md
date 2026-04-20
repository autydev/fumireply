# Infrastructure Design

**Feature**: MVP for Meta App Review Submission
**Branch**: `001-mvp-app-review`
**Date**: 2026-04-20
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
- 例：`fumireply-review-app-lambda`、`fumireply-review-rds`

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

### 3.1 `modules/networking`

**責務**: Lambda が RDS と通信するための VPC / サブネット / セキュリティグループを提供。

| リソース | 用途 |
|----------|------|
| VPC | 10.0.0.0/16 |
| Public Subnet × 2 | NAT Gateway 配置用（AZ 冗長） |
| Private Subnet × 2 | Lambda + RDS 配置用（AZ 冗長） |
| Internet Gateway | Public サブネットの外向き通信 |
| NAT Gateway × 1 | Lambda から Cognito/Meta API への外向き通信（コスト節約のため 1 台のみ）|
| Route Tables | Public / Private 用 |
| VPC Endpoints | SSM、SecretsManager、CloudWatch Logs（NAT 通過を減らしてコスト削減）|

**Inputs**:
- `name_prefix`, `tags`
- `vpc_cidr`（デフォルト `10.0.0.0/16`）

**Outputs**:
- `vpc_id`
- `private_subnet_ids`
- `public_subnet_ids`
- `lambda_security_group_id`（他モジュールが参照）

**設計上の注意**:
- MVP では NAT Gateway 1 台構成（月 $32 程度）。冗長化は Phase 2 以降。
- VPC Endpoints を入れることで NAT 通過量を数割減らせる。

---

### 3.2 `modules/database`

**責務**: RDS Postgres インスタンス + パラメータグループ + サブネットグループ。

| リソース | 設定 |
|----------|------|
| RDS Postgres | `db.t4g.micro`、Postgres 15、ストレージ 20GB gp3、Multi-AZ 無効 |
| DB Subnet Group | Private サブネット × 2 |
| Security Group | Lambda SG からのインバウンド 5432 のみ |
| Parameter Group | `shared_preload_libraries=pg_stat_statements` |
| Automated Backup | 7 日保持、毎日 04:00 JST |

**Inputs**:
- `name_prefix`, `tags`
- `vpc_id`, `private_subnet_ids`
- `lambda_security_group_id`
- `master_username`（デフォルト `postgres`）
- `master_password`（SSM から取得）

**Outputs**:
- `db_endpoint`
- `db_port`
- `db_security_group_id`
- `db_name`

**設計上の注意**:
- 審査期間中は **停止しない**（Aurora Serverless v2 を使わない理由も同じ）。停止すると Webhook が失敗し差し戻しリスク。
- master_password は Terraform state に平文で書かれるリスクがあるため、SSM Parameter Store 経由で参照する（`data.aws_ssm_parameter.rds_master_password`）。

---

### 3.3 `modules/auth`

**責務**: Amazon Cognito User Pool + App Client + Groups + 初期ユーザー。

| リソース | 設定 |
|----------|------|
| User Pool | email ログイン、パスワードポリシー（最小 12 文字、数字 + 記号必須）、MFA 無効（MVP）|
| User Pool Client | Public client（シークレットなし）、`ALLOW_USER_PASSWORD_AUTH` + `ALLOW_REFRESH_TOKEN_AUTH` |
| User Pool Domain | `fumireply-review.auth.ap-northeast-1.amazoncognito.com`（将来 Hosted UI 用、MVP では未使用）|
| User Pool Groups | `operators`、`reviewers` |
| Users | `operator@malbek.co.jp`、`reviewer@malbek.co.jp`（`aws_cognito_user` リソース）|

**Inputs**:
- `name_prefix`, `tags`
- `initial_users`（map：email → group）

**Outputs**:
- `user_pool_id`
- `user_pool_client_id`
- `user_pool_arn`

**設計上の注意**:
- パスワードローテーションはアプリ側で扱わない。Cognito Console / CLI で都度変更。
- Cognito User Pool の削除保護を有効化（`deletion_protection = "ACTIVE"`）。

---

### 3.4 `modules/secrets`

**責務**: SSM Parameter Store のパラメータ定義（値は別途 CLI で投入、Terraform state には含めない）。

| パラメータ | 種別 | 用途 |
|-----------|------|------|
| `/fumireply/review/meta/app-secret` | SecureString | Meta App Secret（Webhook 署名検証用）|
| `/fumireply/review/meta/page-access-token` | SecureString | 長期 Page Access Token |
| `/fumireply/review/meta/webhook-verify-token` | SecureString | Webhook 購読時の verify_token |
| `/fumireply/review/rds/master-password` | SecureString | RDS マスターパスワード |
| `/fumireply/review/cognito/reviewer-password` | SecureString | レビュワー用テストアカウントのパスワード（バックアップ用） |

**Inputs**:
- `name_prefix`

**Outputs**:
- `ssm_path_prefix`（`/fumireply/review/`）

**設計上の注意**:
- Terraform は「パラメータが存在すること」だけを管理し、値は `lifecycle { ignore_changes = [value] }` で管理外にする。値の投入は `aws ssm put-parameter` で手動実施。
- Lambda の IAM ロールに `/fumireply/review/*` の読み取り権限を付与（Least-privilege）。

---

### 3.5 `modules/app-lambda`

**責務**: TanStack Start SSR Lambda + API Gateway HTTP API。

| リソース | 設定 |
|----------|------|
| Lambda Function | `nodejs20.x`、メモリ 1024MB、タイムアウト 30 秒、VPC 内配置 |
| IAM Role | SSM 読み取り、RDS 接続、CloudWatch Logs 書き込み、Cognito `InitiateAuth`/`GlobalSignOut` |
| API Gateway HTTP API | `/api/*`、`/inbox*`、`/threads/*`、`/login` のルーティング |
| Lambda Permissions | API Gateway からの invoke 許可 |
| CloudWatch Log Group | 保持期間 30 日 |

**Inputs**:
- `name_prefix`, `tags`
- `vpc_id`, `private_subnet_ids`, `lambda_security_group_id`
- `db_endpoint`, `db_port`, `db_name`
- `user_pool_id`, `user_pool_client_id`
- `ssm_path_prefix`
- `lambda_package_s3_bucket`, `lambda_package_s3_key`（デプロイ成果物の S3 URI）

**Outputs**:
- `api_gateway_invoke_url`（CloudFront Origin として参照）
- `lambda_function_arn`
- `lambda_function_name`

**設計上の注意**:
- コールドスタート対策として **Provisioned Concurrency は導入しない**（コスト増）。ただし審査期間中だけ最低 1 の Provisioned Concurrency を検討する運用オプションは残す。
- 環境変数として `COGNITO_USER_POOL_ID`、`COGNITO_APP_CLIENT_ID`、`DATABASE_URL`、`NODE_ENV=production` を設定。
- **デプロイ**：Lambda コード本体は S3 経由で更新（Terraform で zip を直接埋め込むと大きな diff が出やすいため）。

---

### 3.6 `modules/static-site`

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
- `api_gateway_invoke_url`（api-lambda モジュールから）
- `route53_zone_id`

**Outputs**:
- `cloudfront_distribution_id`
- `cloudfront_domain_name`
- `s3_bucket_name`（デプロイスクリプトが sync 先として使う）

**Behavior 設定（パスパターンごとの Origin 振り分け）**:

| パスパターン | Origin | キャッシュ |
|-------------|--------|-----------|
| `/api/*` | API Gateway | なし（TTL=0） |
| `/inbox*`, `/threads/*`, `/login` | API Gateway | なし |
| `/_build/*`, `/assets/*` | S3 | 長期（TTL=1年、immutable） |
| `/*`（デフォルト） | S3 | 短期（TTL=5分、HTML 用） |

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

### 3.7 `modules/observability`

**責務**: CloudWatch アラーム + SNS トピック + 通知設定（R-009）。

| リソース | 用途 |
|----------|------|
| SNS Topic | アラート通知宛先 |
| SNS Subscription | Malbek メール（+ 将来 Slack Incoming Webhook）|
| CloudWatch Alarm ×3 | Lambda Error Rate / RDS CPU / Webhook 5xx |
| CloudWatch Dashboard | Lambda 呼び出し数、Webhook 成功率、RDS 接続数 |

**Inputs**:
- `name_prefix`, `tags`
- `lambda_function_name`
- `db_instance_identifier`
- `api_gateway_id`
- `alert_email`

**Outputs**:
- `sns_topic_arn`

**設計上の注意**:
- アラームのしきい値は審査期間中と平常時で変える想定（envs/review では厳しめ）。

---

## 4. モジュール依存グラフ

```
                     ┌──────────────┐
                     │ networking   │
                     └──────┬───────┘
                            │ vpc_id, subnet_ids, sg_id
              ┌─────────────┼──────────────┐
              ▼             ▼              ▼
         ┌────────┐   ┌──────────┐   ┌──────────┐
         │database│   │ app-     │   │(future)  │
         │        │   │ lambda   │   │ workers  │
         └───┬────┘   └────┬─────┘   └──────────┘
             │             │
             │ db_endpoint │
             └─────────────┤
                           │
            ┌──────────────┼───────────────┐
            ▼              ▼               ▼
       ┌────────┐    ┌──────────┐    ┌──────────┐
       │ auth   │    │ secrets  │    │observa-  │
       │cognito │    │ ssm      │    │ bility   │
       └───┬────┘    └────┬─────┘    └──────────┘
           │              │
           │  pool_id     │ ssm_path_prefix
           ▼              ▼
        ┌──────────────────────┐
        │    app-lambda        │
        └─────────┬────────────┘
                  │ api_gateway_invoke_url
                  ▼
           ┌──────────────┐
           │ static-site  │
           │ (S3+CloudF)  │
           └──────────────┘
```

**Apply 順序**:

1. `bootstrap/`（state リソース作成、1 回のみ）
2. `envs/review/`（一括 apply：Terraform が依存関係を自動解決）

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
  1. npm ci + npm run build
  2. zip → S3 にアップロード（Lambda package）
  3. aws lambda update-function-code
  4. 静的ファイル → S3 sync（static-site 用）
  5. CloudFront invalidation（`/*`）
  6. DB マイグレーション（必要時のみ、手動承認後）
```

**原則**:
- Lambda コードと静的ファイルは同一パイプラインで同時更新（整合性確保）
- DB マイグレーションは **手動承認ゲート**の後ろ（自動実行しない）

### 6.3 初回デプロイ手順（Terraform apply 順序）

詳細は [`quickstart.md`](./quickstart.md) に記載する流れの通り。要点：

1. Bootstrap apply（State 管理リソース）
2. `secrets` モジュール apply → SSM パラメータ定義作成
3. CLI で SSM に実値を手動投入
4. `envs/review` を全モジュール apply
5. Cognito テストユーザー作成（CLI）
6. 初回 Lambda デプロイ（GitHub Actions or 手動）
7. 初回 DB マイグレーション

---

## 7. コスト試算（MVP 版・月額）

design v2 の試算から MVP 構成に合わせて補正：

| サービス | 初年度 | 2 年目以降 | 備考 |
|----------|-------|-----------|------|
| Lambda（SSR + Webhook + API）| 無料枠内 | 無料枠内（永久）| 100万リクエスト/月の無料枠 |
| API Gateway HTTP API | 〜$1 | 〜$1 | 100万リクエスト/月 $1 |
| RDS Postgres `db.t4g.micro` | 無料枠内 | 〜$15-20 | 無料枠は 750h/月 × 12ヶ月 |
| Cognito User Pool | 無料枠内 | 無料枠内（永久） | 50,000 MAU まで無料 |
| CloudFront | 〜$1 | 〜$1 | 1TB 配信/月の無料枠 |
| S3 | 〜$0.5 | 〜$0.5 | SSG 成果物 + Lambda パッケージ数MB |
| NAT Gateway | 〜$32 | 〜$32 | 時間課金 + データ処理料 |
| VPC Endpoints（SSM 等）| 〜$8 | 〜$8 | 4 エンドポイント × $0.01/h |
| SSM Parameter Store | 無料枠内 | 無料枠内（永久） | Standard Tier は無料 |
| CloudWatch Logs + アラーム | 〜$3 | 〜$3 | |
| **合計** | **〜$45-46/月** | **〜$60-65/月** | design v2 より NAT + VPC Endpoints で $40 増 |

### コスト削減の選択肢（推奨しない、後続案）

- **NAT Gateway 省略**：Lambda を VPC 外に出し、RDS Proxy で接続 → NAT 不要。ただし RDS Proxy は $15/月。
- **Aurora Serverless v2**：最小 0.5 ACU で $22/月。RDS micro より高い。
- **SQLite + EFS**：マイクロアプリ向け。Phase 2 拡張時に書き直し必須になるため非推奨。

MVP 段階では NAT + RDS micro 構成のまま進める（月 $45 は許容範囲）。

---

## 8. セキュリティ設計

### 8.1 IAM（Least-privilege）

Lambda 実行ロールの権限：

- `ssm:GetParameter` — `arn:aws:ssm:*:*:parameter/fumireply/review/*` 限定
- `rds-db:connect` — 特定 DB ユーザー限定（IAM Database Authentication 使用時）
- `cognito-idp:InitiateAuth`、`cognito-idp:GlobalSignOut` — 特定 User Pool ARN 限定
- `logs:CreateLogStream`、`logs:PutLogEvents` — 自身の Log Group 限定
- `ec2:CreateNetworkInterface` 等の VPC 関連 — VPC 接続用（AWS 管理ポリシー `AWSLambdaVPCAccessExecutionRole`）

**絶対に与えない権限**:
- `*` リソースへの `s3:*`（CloudFront OAC で S3 を CloudFront 専用にする）
- `iam:*`（Lambda から IAM 操作は不要）
- `ec2:*`（VPC 関連の最小限のみ）

### 8.2 Secrets 管理

- **平文で DB / Git に置かない**：Meta トークン、RDS パスワード、Cognito reviewer パスワード
- **Terraform state に含めない**：値は SSM 経由で参照、`lifecycle { ignore_changes = [value] }` で管理外
- **Lambda 環境変数に Secret を入れない**：SSM から起動時に取得、メモリキャッシュ

### 8.3 ネットワーク分離

- RDS は **private subnet** に配置、public 経由のアクセス不可
- Lambda も private subnet 配置、インターネット通信は NAT 経由のみ
- API Gateway は public だが、認証（JWT）と Webhook 署名検証で保護
- S3 バケットは public access block、CloudFront OAC 経由のみアクセス可

### 8.4 暗号化

- **保存時**：RDS（storage_encrypted = true、KMS）、S3（SSE-S3 または KMS）、SSM（SecureString + KMS）、Terraform state（KMS）
- **転送時**：すべて HTTPS（ACM 証明書）、RDS 接続は SSL 有効（`sslmode=require`）

### 8.5 監査

- CloudTrail は AWS アカウント全体で有効化（本プロジェクト外で設定済み想定）
- Cognito User Pool の sign-in イベントは CloudWatch Logs に出力設定可能（MVP では未設定、Phase 2 で検討）

---

## 9. 運用上の注意点

### 9.1 審査期間中の固定事項

- RDS インスタンスを**停止しない**
- Lambda 関数を**削除しない**
- CloudFront Distribution を**無効化しない**
- Cognito reviewer パスワードを**変更しない**

### 9.2 災害時の復旧順序（DR）

1. RDS スナップショットから復元
2. Terraform apply で他リソース再作成
3. Lambda コードを再デプロイ
4. 静的ファイルを S3 に再 sync
5. CloudFront invalidation

RTO 目標：**4 時間以内**（審査期間中のダウンタイムは極力避ける）。

### 9.3 定期タスク

- 月次：Meta Page Access Token の有効性確認（ローテーション不要だが念のため）
- 月次：AWS コスト確認
- 四半期：不要リソースの棚卸し

詳細は `docs/operations/audit-runbook.md` に記載する。

---

## 10. Phase 2 以降の拡張方針

| 追加する機能 | 新規 or 既存モジュール変更 |
|-------------|-----------------------------|
| Webhook 専用 Lambda 分離 | `modules/webhook-lambda` を新規追加、`app-lambda` から `/api/webhook` を除外 |
| SQS + 分類 Lambda | `modules/queue`、`modules/classifier-lambda` を新規追加 |
| Instagram DM 連携 | `app-lambda` と `webhook-lambda` の IAM 権限追加のみ（モジュール構造は変更なし） |
| マルチテナント | `auth` モジュールに `custom:tenant_id` 属性追加、`database` のスキーマ変更 |
| RDS Multi-AZ 冗長化 | `database` モジュールの `multi_az = true` 変更のみ |
| WebSocket リアルタイム通知 | `modules/websocket` 新規追加（API Gateway WebSocket + DynamoDB connection table）|

いずれも**既存モジュールを大きく変更せず、新規モジュール追加で拡張できる**ように境界を設計している。

---

## 関連ドキュメント

- [`plan.md`](./plan.md) — 実装プラン全体
- [`research.md`](./research.md) — 技術選定の根拠（R-002 Cognito、R-010 ルート別レンダリング 等）
- [`quickstart.md`](./quickstart.md) — 初回セットアップ手順
- [`data-model.md`](./data-model.md) — DB スキーマ
- [`contracts/`](./contracts/) — 外部 API / 内部 API の契約
