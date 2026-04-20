# Quickstart: MVP for Meta App Review

**Feature**: `001-mvp-app-review`
**Audience**: 開発着手する開発者 / 審査準備を進める申請者

---

## 0. 前提

| 準備物 | 状態 |
|--------|------|
| AWS アカウント（Malbek） | 用意済み想定 |
| Meta for Developers アカウント | Malbek の Business アカウント配下 |
| 独自ドメイン（例: `malbek.co.jp`） | 取得済み + Route53 or 他 DNS 管理 |
| GitHub リポジトリ | 本リポジトリ（fumireply） |
| Node.js 20.x / **npm**（pnpm・yarn は使わない。lockfile は `package-lock.json` を正とし、CI は `npm ci` でインストールする） | ローカル開発用 |
| Terraform CLI | AWS リソース構築用 |
| AWS CLI + 認証プロファイル | Terraform apply 用 |

---

## 1. ローカル開発環境の立ち上げ

```bash
# 依存インストール
npm install

# DB ローカル起動（docker-compose）
docker compose up -d postgres

# マイグレーション適用
npm run db:migrate

# 初期データ投入（connected_pages の seed のみ。ユーザーは Cognito 側）
npm run db:seed

# Cognito User Pool へのテストユーザー登録（後述 2.5 参照）

# 開発サーバー起動
npm run dev
```

- ローカル URL: `http://localhost:3000`
- 初期ログイン: `operator@malbek.co.jp` / 初期パスワードは Cognito 側で発行（2.5 で SSM に記録、初回ログイン時に強制変更）

**ローカル開発時の注意**: 認証フローのローカル検証は、実際の Cognito User Pool（`envs/review` or 別途 `envs/local`）に対して行う。Cognito にはローカルモックが存在しないため、AWS アカウント上に `envs/local` 用の User Pool を作ることを推奨する。

---

## 2. Meta 側のセットアップ

### 2.1 Business Verification を並行して申請（最重要ブロッカー）

仕様書 [`spec.md`](./spec.md) の Assumptions 節の通り、本アプリ開発と並行して Business Verification を申請する。これが通らないと Advanced Access が取れない。

1. https://business.facebook.com/settings/security にアクセス
2. Security Center → Start Verification
3. 必要書類：履歴事項全部証明書、独自ドメイン Web サイト、会社メール（ドメイン一致）、電話受電可能な番号

### 2.2 Meta for Developers でアプリ作成

1. https://developers.facebook.com/apps/create/
2. アプリタイプ：**Business**
3. ビジネスポートフォリオ：Malbek
4. アプリ名：`Malbek Messenger Assistant`
5. アプリ作成後、**Messenger プロダクトを追加**

### 2.3 テスト FB ページを連携

1. Messenger API Settings → Generate access tokens
2. 対象のテスト FB ページを Connect → Generate
3. 生成された短期 Page Access Token をメモ

### 2.4 長期 Page Access Token に変換

```bash
# 短期ユーザートークンを取得（Graph API Explorer から手動でコピー）
SHORT_USER_TOKEN="<xxx>"
APP_ID="<app_id>"
APP_SECRET="<app_secret>"

# 長期ユーザートークンへ交換
LONG_USER_TOKEN=$(curl -s "https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${SHORT_USER_TOKEN}" | jq -r .access_token)

# 長期 Page Access Token を取得
curl -s "https://graph.facebook.com/v19.0/me/accounts?access_token=${LONG_USER_TOKEN}" | jq .
# → 該当ページの .data[].access_token が長期 Page Access Token
```

### 2.5 SSM Parameter Store に登録

```bash
aws ssm put-parameter \
  --name "/fumireply/review/meta/page-access-token" \
  --type "SecureString" \
  --value "<LONG_PAGE_ACCESS_TOKEN>"

aws ssm put-parameter \
  --name "/fumireply/review/meta/app-secret" \
  --type "SecureString" \
  --value "<APP_SECRET>"

aws ssm put-parameter \
  --name "/fumireply/review/meta/webhook-verify-token" \
  --type "SecureString" \
  --value "$(openssl rand -hex 16)"

# Data Deletion Callback で使う PSID ハッシュ salt（32 バイトランダム）。
# `data-model.md` の deletion_log テーブル設計と
# `infrastructure.md` §3.4 の SSM 定義に対応。
# 初回デプロイ前に必ず投入すること（未設定だと削除コールバックが失敗する）。
aws ssm put-parameter \
  --name "/fumireply/review/deletion-log/hash-salt" \
  --type "SecureString" \
  --value "$(openssl rand -hex 32)"
```

---

## 3. AWS インフラ構築（Terraform）

```bash
cd terraform/envs/review
terraform init
terraform plan -out tfplan
terraform apply tfplan
```

構築される AWS リソース：

- RDS Postgres `db.t4g.micro`（VPC 内プライベートサブネット）
- Lambda（TanStack Start SSR アプリ + Webhook ハンドラ）
- API Gateway HTTP API（`/api/webhook`, `/api/data-deletion`, `/inbox*`, `/threads/*`, `/login` 等）
- **S3 バケット**（SSG 公開ページ + CSR login ページの静的ファイル配信元）
- CloudFront + ACM 証明書（独自ドメイン配下、S3 と API Gateway の 2 Origin を振り分け）
- **Cognito User Pool + App Client**（認証基盤）
- **Cognito Groups**（`operators`, `reviewers`）
- SSM Parameter Store（上記 2.5 で既に登録済みの値を参照）
- CloudWatch Logs + アラーム 3 種（R-009）

### 3.1 Cognito テストユーザー作成（Terraform apply 後）

Terraform で User Pool 本体が作られたら、テストユーザーを手動または Terraform の `aws_cognito_user` リソースで作成。**パスワードは必ずコマンドラインで乱数生成し、定数をコピペ流用しない**。

> ⚠️ **Reviewer アカウントのパスワード運用ルール**（`infrastructure.md` §8.6、§9.1 と一致）:
> - **審査提出時〜結果通知までの期間中は、reviewer パスワードを変更しない**（Meta の申請フォームに記載した認証情報が無効化されると「Cannot reproduce」差し戻しの原因になる）。
> - 審査期間外（初回セットアップ時・承認/却下通知後 24 時間以内）は、本節の `admin-set-user-password` を再実行して新規 random 値にローテーションしてよい。
> - 開発環境のテストで reviewer 相当の挙動を確認する際は、別途 `envs/local` の User Pool を使い、本番 `envs/review` のパスワードを流用しない。

```bash
# User Pool ID を Terraform output から取得
USER_POOL_ID=$(terraform output -raw cognito_user_pool_id)
APP_CLIENT_ID=$(terraform output -raw cognito_app_client_id)

# ---- オペレーターユーザー ----
OP_TEMP_PASSWORD=$(openssl rand -base64 24)
OP_PERM_PASSWORD=$(openssl rand -base64 24)

aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username "operator@malbek.co.jp" \
  --user-attributes Name=email,Value=operator@malbek.co.jp Name=email_verified,Value=true \
  --temporary-password "$OP_TEMP_PASSWORD" \
  --message-action SUPPRESS

aws cognito-idp admin-add-user-to-group \
  --user-pool-id $USER_POOL_ID \
  --username "operator@malbek.co.jp" \
  --group-name "operators"

aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username "operator@malbek.co.jp" \
  --password "$OP_PERM_PASSWORD" \
  --permanent

# オペレーター恒久パスワードを SSM にバックアップ保管
aws ssm put-parameter \
  --name "/fumireply/review/cognito/operator-password" \
  --type SecureString \
  --value "$OP_PERM_PASSWORD"

# ---- レビュワー用テストアカウント ----
REVIEWER_PERM_PASSWORD=$(openssl rand -base64 24)
REVIEWER_TEMP_PASSWORD=$(openssl rand -base64 24)

aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username "reviewer@malbek.co.jp" \
  --user-attributes Name=email,Value=reviewer@malbek.co.jp Name=email_verified,Value=true \
  --temporary-password "$REVIEWER_TEMP_PASSWORD" \
  --message-action SUPPRESS

aws cognito-idp admin-add-user-to-group \
  --user-pool-id $USER_POOL_ID \
  --username "reviewer@malbek.co.jp" \
  --group-name "reviewers"

aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username "reviewer@malbek.co.jp" \
  --password "$REVIEWER_PERM_PASSWORD" \
  --permanent

# レビュワーパスワードを SSM に保管（申請フォームにはこの値を記載）
aws ssm put-parameter \
  --name "/fumireply/review/cognito/reviewer-password" \
  --type SecureString \
  --value "$REVIEWER_PERM_PASSWORD"

echo "Reviewer password for Meta submission: $REVIEWER_PERM_PASSWORD"
```

**レビュワーアカウントのセキュリティ補償統制**:
- 2FA・IP 制限を外す代わりに、以下の補償統制を必ず運用する（詳細は `infrastructure.md` §8.6 と `docs/operations/audit-runbook.md`）：
  1. **審査提出時にのみ enable**：それ以外の期間は `admin-disable-user` で無効化
  2. **承認／却下通知後 24 時間以内にパスワード変更 + 無効化**
  3. **reviewer アカウントのサインイン成功イベントは即時 Slack/メール通知**（CloudWatch + SNS 経由）
  4. **Cognito Advanced Security Features** の UnusualSignInActivity 検知を有効化
- IAM Role（Lambda 実行 + SSM 読み取り + CloudWatch 書き込み）

**所要時間**: RDS 作成含めて 15〜20 分

---

## 4. デプロイ & Webhook 購読

```bash
# TanStack Start をビルド
npm run build

# Lambda にデプロイ（serverless-framework や自前スクリプト、Terraform 経由 etc.）
npm run deploy:review

# DB マイグレーション（RDS 接続、Bastion 経由 or Lambda 経由のワンショット）
npm run db:migrate:review
npm run db:seed:review
```

### Webhook 購読設定

1. Meta App Dashboard → Messenger → Settings → Webhooks
2. Callback URL: `https://review.malbek.co.jp/api/webhook`
3. Verify Token: SSM の `/fumireply/review/meta/webhook-verify-token` と同値
4. Subscribe Fields: `messages`, `messaging_postbacks`（MVP では postbacks 未使用、将来用に入れておく）
5. Verify and Save → 成功なら購読完了

### データ削除コールバック URL 設定

1. App Dashboard → App Settings → Advanced → Data Deletion Request URL
2. URL: `https://review.malbek.co.jp/api/data-deletion`
3. Save

---

## 5. 疎通確認（スモークテスト）

### 5.1 Webhook 検証エンドポイント（CLI 確認可能）

```bash
curl "https://review.malbek.co.jp/api/webhook?hub.mode=subscribe&hub.verify_token=<TOKEN>&hub.challenge=test123"
# → test123
```

### 5.2 ログインと管理画面（ブラウザで確認）

ログインは TanStack Start の `createServerFn` 経由で処理されるため、curl での直接 POST は呼び出し規約の観点から非推奨。ブラウザで画面を開いて確認する：

1. `https://review.malbek.co.jp/login` をブラウザで開く
2. SSM に保管した `operator@malbek.co.jp` のパスワードでログイン
3. 受信トレイ画面（`/inbox`）に遷移すること、Cookie（`id_token`、`refresh_token`）が発行されることを DevTools で確認

### 5.3 データ削除エンドポイント（Meta App Dashboard から）

Meta App Dashboard の Data Deletion Request URL 設定画面で「Send test」を押し、200 応答が返ることを確認する。

### エンドツーエンド確認

1. スマホの Messenger アプリからテスト FB ページに「Hello, test message」を送る
2. 管理画面（`https://review.malbek.co.jp`）にログイン
3. 受信トレイに 30 秒以内にメッセージが表示されること（FR-001）
4. スレッドを開く → 返信欄に「Thanks for your message」と入力 → 送信
5. 5 秒以内に Messenger アプリに返信が届くこと（SC-004）

---

## 6. 審査提出前チェックリスト

以下すべてが整った時点で App Review を提出する：

- [ ] Business Verification **承認済み**
- [ ] ドメイン `malbek.co.jp` で HTTPS 配信（ACM 証明書有効）
- [ ] 管理画面（`https://review.malbek.co.jp`）で疎通確認成功
- [ ] プライバシーポリシー URL（`https://malbek.co.jp/privacy`）が 200 + コンテンツ完備
- [ ] 利用規約 URL が 200
- [ ] データ削除コールバック URL 登録 + テストリクエストで 200
- [ ] Webhook 購読有効化（緑チェック）
- [ ] 長期 Page Access Token で 1 週間以上送受信できることを確認
- [ ] スクリーンキャスト動画（2〜3 分、字幕付き）撮影済み + YouTube 限定公開
- [ ] Use Case 説明文（英語）確定（R-008 テンプレート準拠）
- [ ] レビュワー用テストアカウント作成済み（`reviewer@malbek.co.jp`、2FA なし、IP 制限なし）
- [ ] テストアカウントの認証情報を申請フォームに記載
- [ ] CloudWatch アラーム 3 種有効化（R-009）
- [ ] RDS 自動停止スケジュールを無効化（審査期間中は常時稼働）

---

## 7. 審査期間中の運用

| 項目 | 対応 |
|------|------|
| 稼働監視 | CloudWatch アラームをメール + Slack に通知 |
| Page Access Token 失効 | 管理画面ヘッダーで検知 → 手動で再発行 → SSM 更新 → Lambda 再デプロイ |
| 差し戻し対応 | 差し戻し理由を読み、動画の追補 or 実装修正で再提出 |
| 承認後 | `/speckit.tasks` → `/speckit.implement` で Phase 2 機能に着手 |

詳細は `docs/operations/audit-runbook.md` に記載する。

---

## 8. トラブルシューティング

### Webhook が届かない

1. Meta App Dashboard → Webhook ページで「Recent Deliveries」を確認
2. 401 が記録されている → 署名検証失敗（APP_SECRET の SSM 値を再確認）
3. タイムアウト → Lambda のコールドスタート時間を確認、10 秒超えていたら要調査

### Send API が 400 + code 190

- トークン失効。Graph API Explorer で新しい長期 Page Access Token を再取得し、SSM を更新。

### Send API が 400 + subcode 2018278

- 24 時間窓超過。MVP スコープでは対応不可、レビュワーに新しいメッセージを送ってもらう運用。

### CloudFront 経由で Webhook が届かない

- API Gateway へのルーティング設定を確認。`/api/*` は CloudFront の Origin Request Policy で全ヘッダー + Body を Pass through する必要あり。

---

## 9. 次のステップ

1. 本 Quickstart を踏まえて `/speckit.tasks` を実行し、実装タスク分解を生成
2. `/speckit.implement` で段階的に実装
3. Business Verification 承認待ちの間にインフラ・アプリを構築
4. すべての [審査提出前チェックリスト](#6-審査提出前チェックリスト) が埋まったら App Review 提出
