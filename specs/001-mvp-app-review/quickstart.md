# Quickstart: MVP for Meta App Review

**Feature**: `001-mvp-app-review`
**Audience**: 開発着手する開発者 / 審査準備を進める申請者
**Updated**: 2026-04-30 (Supabase + Anthropic API 構成)

---

## 0. 前提

| 準備物 | 状態 |
|--------|------|
| AWS アカウント（Malbek） | 用意済み想定 |
| Supabase アカウント | 無料プラン、東京リージョンでプロジェクト作成 |
| Anthropic API アカウント | API キー発行済み（クレジット課金、最低 $5 入金推奨）|
| Meta for Developers アカウント | Malbek の Business アカウント配下 |
| 独自ドメイン（例: `malbek.co.jp`） | 取得済み + Route53 or 他 DNS 管理 |
| GitHub リポジトリ | 本リポジトリ（fumireply） |
| Node.js 24.x（AWS Lambda `nodejs24.x` 対応、2026-04 時点で GA）/ **npm**（pnpm・yarn は使わない。lockfile は `package-lock.json` を正とし、CI は `npm ci` でインストールする） | ローカル開発用 |
| Terraform CLI 1.6+ | AWS リソース構築用 |
| AWS CLI + 認証プロファイル | Terraform apply 用 |

---

## 1. ローカル開発環境の立ち上げ

```bash
# 依存インストール
cd app && npm install

# .env.local 作成（Supabase URL / anon key / DB URL を自分の Supabase プロジェクトから貼る）
cat > .env.local <<EOF
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=<anon-key>
DATABASE_URL=postgres://postgres.<project>:<password>@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres
ANTHROPIC_API_KEY=<your-api-key>
META_APP_SECRET=dummy-for-local
META_WEBHOOK_VERIFY_TOKEN=dummy-for-local
EOF

# マイグレーション適用（Supabase に対して）
npm run db:migrate

# 初期データ投入（connected_pages の seed のみ。ユーザーは Supabase 側）
npm run db:seed

# 開発サーバー起動
npm run dev
```

- ローカル URL: `http://localhost:3000`
- 初期ログイン: Supabase ダッシュボードで作成したユーザー（後述 2.6 参照）

**ローカル開発時の注意**: 認証フローのローカル検証は、本番と同じ Supabase プロジェクト（または別途 dev 用 Supabase プロジェクト）に対して行う。Supabase Auth はローカルモック（`supabase start` でローカル起動）も可能だが、MVP では本物の Supabase プロジェクトを直接叩く方がシンプル。

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

### 2.5 Supabase プロジェクトの作成

1. https://supabase.com/dashboard で新規プロジェクト作成
2. リージョン：**Northeast Asia (Tokyo)**
3. プラン：**Free**（MVP）
4. プロジェクト URL（`https://<project>.supabase.co`）、anon key、service role key を控える
5. **Pooler 接続文字列**（Settings → Database → Connection Pooling → Transaction mode）を控える：
   ```
   postgres://postgres.<project>:<password>@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres
   ```

### 2.6 SSM Parameter Store に登録

**注**: マルチテナント化により Page Access Token は SSM ではなく DB の暗号化カラム（`connected_pages.page_access_token_encrypted`）に保存する。SSM には**全テナント共通の値**とマスター鍵だけを置く。

```bash
# Meta 関連（全テナント共通：単一 Meta App 配下）
aws ssm put-parameter \
  --name "/fumireply/review/meta/app-secret" \
  --type "SecureString" --value "<APP_SECRET>"

aws ssm put-parameter \
  --name "/fumireply/review/meta/webhook-verify-token" \
  --type "SecureString" --value "$(openssl rand -hex 16)"

# Supabase
aws ssm put-parameter \
  --name "/fumireply/review/supabase/url" \
  --type "SecureString" --value "https://<project>.supabase.co"

aws ssm put-parameter \
  --name "/fumireply/review/supabase/anon-key" \
  --type "SecureString" --value "<SUPABASE_ANON_KEY>"

aws ssm put-parameter \
  --name "/fumireply/review/supabase/service-role-key" \
  --type "SecureString" --value "<SUPABASE_SERVICE_ROLE_KEY>"

aws ssm put-parameter \
  --name "/fumireply/review/supabase/db-url" \
  --type "SecureString" --value "postgres://postgres.<project>:<password>@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres"

# Anthropic（全テナント共通）
aws ssm put-parameter \
  --name "/fumireply/review/anthropic/api-key" \
  --type "SecureString" --value "<ANTHROPIC_API_KEY>"

# Data Deletion Callback の PSID ハッシュ salt
aws ssm put-parameter \
  --name "/fumireply/review/deletion-log/hash-salt" \
  --type "SecureString" --value "$(openssl rand -hex 32)"

# Page Access Token 暗号化用マスター鍵（AES-256、32 bytes hex）
# ⚠️ この鍵をローテーションする際は全 connected_pages.page_access_token_encrypted を再暗号化する必要があるため
#    生成後は紛失しないよう audit-runbook.md にも記載のこと
aws ssm put-parameter \
  --name "/fumireply/master-encryption-key" \
  --type "SecureString" --value "$(openssl rand -hex 32)"
```

---

## 3. AWS インフラ構築（Terraform）

```bash
cd terraform/envs/review
terraform init
terraform plan -out tfplan
terraform apply tfplan
```

構築される AWS リソース（VPC・RDS・Cognito・NAT Gateway は廃止）：

- **app-lambda**: TanStack Start SSR Lambda（Lambda Web Adapter Layer 経由、VPC 外）
- **webhook-lambda**: Webhook 受信専用 Lambda（VPC 外、署名検証 + DB INSERT + SQS enqueue）
- **ai-worker-lambda**: AI 下書き生成 Worker Lambda（SQS Trigger、Anthropic API 呼び出し）
- **keep-alive-lambda**: Supabase Pause 回避 Lambda（EventBridge `rate(1 day)` Trigger、内部 3 回リトライ + SNS 失敗通知 + 36 時間 Invocation なし検知の多重防御）
- API Gateway HTTP API（`/api/webhook` → webhook-lambda、それ以外 → app-lambda）
- SQS Queue + DLQ（AI 下書き生成キュー）
- **S3 バケット**（SSG 公開ページ + CSR login ページの静的ファイル配信元）
- CloudFront + ACM 証明書（独自ドメイン配下、S3 と API Gateway の 2 Origin を振り分け）
- SSM Parameter Store（上記 2.6 で既に登録済みの値を参照）
- CloudWatch Logs + アラーム（app/webhook/ai-worker のエラーレート、DLQ、keep-alive 失敗）
- EventBridge Scheduled Rule（keep-alive 用）

### 3.1 初期テナント + Connected Page の seed（Terraform apply 後）

Supabase Auth ユーザー作成の**前に**、tenant と connected_pages を seed する。`npm run db:seed:review` は以下を実行する：

1. `tenants` に Malbek の行を INSERT（`slug='malbek'`, `plan='free'`, `status='active'`）→ `tenant_id` 取得
2. SSM `/fumireply/master-encryption-key` を取得 → Page Access Token を AES-256-GCM 暗号化
3. `connected_pages` に INSERT（`tenant_id`, `page_id`, `page_name`, `page_access_token_encrypted`, `webhook_verify_token_ssm_key='/fumireply/review/meta/webhook-verify-token'`）

```bash
export DATABASE_URL=$(aws ssm get-parameter --name /fumireply/review/supabase/db-url --with-decryption --query 'Parameter.Value' --output text)
export SSM_PATH_PREFIX=/fumireply/

# 環境変数として Page Access Token を渡す（コマンド履歴に残らないよう注意）
read -s -p "Long Page Access Token: " META_PAGE_ACCESS_TOKEN; echo
export META_PAGE_ACCESS_TOKEN
export META_PAGE_ID="<Facebook page ID>"
export META_PAGE_NAME="<page display name>"
export TENANT_SLUG=malbek
export TENANT_NAME=Malbek

npm run db:seed:review --prefix app

# 完了後、tenant_id を確認
psql "$DATABASE_URL" -c "SELECT id, slug, name FROM tenants;"
```

`tenant_id` は次のステップでユーザー作成時に `user_metadata.tenant_id` として使う。

### 3.2 Supabase Auth テストユーザー作成（Terraform apply 後）

Terraform で AWS リソースが作られ、tenant が seed された後、Supabase の Admin API でテストユーザーを作成する：

> ⚠️ **Reviewer アカウントのパスワード運用ルール**:
> - **審査提出時〜結果通知までの期間中は、reviewer パスワードを変更しない**（Meta の申請フォームに記載した認証情報が無効化されると「Cannot reproduce」差し戻しの原因になる）。
> - 審査期間外（初回セットアップ時・承認/却下通知後 24 時間以内）は、Supabase ダッシュボードの "Reset Password" でローテーションしてよい。

```bash
SUPABASE_URL=$(aws ssm get-parameter --name /fumireply/review/supabase/url --with-decryption --query 'Parameter.Value' --output text)
SUPABASE_SERVICE_KEY=$(aws ssm get-parameter --name /fumireply/review/supabase/service-role-key --with-decryption --query 'Parameter.Value' --output text)

# 直前に seed した Malbek tenant の UUID を取得
TENANT_ID=$(psql "$DATABASE_URL" -tA -c "SELECT id FROM tenants WHERE slug = 'malbek';")

# ---- オペレーターユーザー ----
OP_PASSWORD=$(openssl rand -base64 24)

curl -X POST "${SUPABASE_URL}/auth/v1/admin/users" \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"operator@malbek.co.jp\",
    \"password\": \"${OP_PASSWORD}\",
    \"email_confirm\": true,
    \"user_metadata\": { \"tenant_id\": \"${TENANT_ID}\", \"role\": \"operator\" }
  }"

# パスワードを SSM にバックアップ
aws ssm put-parameter \
  --name "/fumireply/review/supabase/operator-password" \
  --type SecureString --value "$OP_PASSWORD" --overwrite

# ---- レビュワー用テストアカウント ----
REVIEWER_PASSWORD=$(openssl rand -base64 24)

curl -X POST "${SUPABASE_URL}/auth/v1/admin/users" \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"reviewer@malbek.co.jp\",
    \"password\": \"${REVIEWER_PASSWORD}\",
    \"email_confirm\": true,
    \"user_metadata\": { \"tenant_id\": \"${TENANT_ID}\", \"role\": \"reviewer\" }
  }"

aws ssm put-parameter \
  --name "/fumireply/review/supabase/reviewer-password" \
  --type SecureString --value "$REVIEWER_PASSWORD" --overwrite
```

上記実行後、レビュー提出で使う reviewer パスワードは SSM から必要時に取得し、標準出力には表示しない。

**レビュワーアカウントのセキュリティ補償統制**:
- 平常時は Supabase ダッシュボードで `banned_until` を未来日に設定して無効化
- 審査提出時にのみ有効化（`banned_until` を NULL にする）
- 承認/却下通知後 24 時間以内に再無効化 + パスワード変更 + SSM 更新
- 詳細は `infrastructure.md` §8.6、`docs/operations/audit-runbook.md`

**所要時間**: Terraform apply 含めて 10〜15 分（VPC/RDS が消えたので旧版より大幅短縮）

---

## 4. デプロイ & Webhook 購読

```bash
# 各 Lambda パッケージをビルド
npm run build --prefix app
npm run build --prefix webhook
npm run build --prefix ai-worker
npm run build --prefix keep-alive

# Lambda にデプロイ（4 関数）
npm run deploy:review

# DB マイグレーション（Supabase Pooler 経由、ローカルから or CI から）
DATABASE_URL=$(aws ssm get-parameter --name /fumireply/review/supabase/db-url --with-decryption --query 'Parameter.Value' --output text) \
  npm run db:migrate

# 初期データ投入（connected_pages の seed）
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
3. 受信トレイ画面（`/inbox`）に遷移すること、Cookie（`sb-access-token`、`sb-refresh-token` 等）が発行されることを DevTools で確認

### 5.3 データ削除エンドポイント（Meta App Dashboard から）

Meta App Dashboard の Data Deletion Request URL 設定画面で「Send test」を押し、200 応答が返ることを確認する。

### 5.4 AI 下書き生成の疎通

1. テスト FB ページに Messenger メッセージを送信
2. CloudWatch Logs で Webhook 受信 → SQS enqueue → Worker Lambda 起動 → Anthropic API 呼び出しのフローを確認
3. 管理画面のスレッドを開き、`ai_drafts.body` に下書きが生成されていることを確認（60 秒以内）
4. 失敗時は CloudWatch Logs Insights で `ai_drafts.error` カラムを確認

### エンドツーエンド確認

1. スマホの Messenger アプリからテスト FB ページに「Hello, test message」を送る
2. 管理画面（`https://review.malbek.co.jp`）にログイン
3. 受信トレイに 30 秒以内にメッセージが表示されること（FR-001）
4. スレッドを開く → AI 下書きが返信欄にプリセットされていること（FR-022〜FR-024）
5. 下書きを確認/編集 → 送信
6. 5 秒以内に Messenger アプリに返信が届くこと（SC-004）

---

## 6. 審査提出前チェックリスト

以下すべてが整った時点で App Review を提出する：

- [ ] Business Verification **承認済み**
- [ ] ドメイン `malbek.co.jp` で HTTPS 配信（ACM 証明書有効）
- [ ] 管理画面（`https://review.malbek.co.jp`）で疎通確認成功
- [ ] プライバシーポリシー URL（`https://malbek.co.jp/privacy`）が 200 + コンテンツ完備（**Anthropic への第三者提供を明記**）
- [ ] 利用規約 URL が 200
- [ ] データ削除コールバック URL 登録 + テストリクエストで 200
- [ ] Webhook 購読有効化（緑チェック）
- [ ] 長期 Page Access Token で 1 週間以上送受信できることを確認
- [ ] **AI 下書き生成が 60 秒以内に表示されることを 10 件で確認**（SC-008）
- [ ] スクリーンキャスト動画（2〜3 分、字幕付き、**Human-in-the-Loop を明示**）撮影済み + YouTube 限定公開
- [ ] Use Case 説明文（英語、AI 下書きを主機能として記述）確定（R-008 テンプレート準拠）
- [ ] レビュワー用テストアカウント有効化済み（`reviewer@malbek.co.jp`、2FA なし、IP 制限なし）
- [ ] テストアカウントの認証情報を申請フォームに記載
- [ ] CloudWatch アラーム有効化（R-009）
- [ ] **Supabase keep-alive Lambda が動作していることを確認**（FR-027）

---

## 7. 審査期間中の運用

| 項目 | 対応 |
|------|------|
| 稼働監視 | CloudWatch アラームをメール + Slack に通知 |
| **Supabase Pause 監視** | keep-alive Lambda（毎日起動）の Errors >= 1 即時通知 + 36h Invocation なし検知 + 内部 3 回リトライの多重防御。Supabase ダッシュボードでも 1 日 1 回目視確認 |
| Page Access Token 失効 | 管理画面ヘッダーで検知 → 手動で長期トークンを再発行 → AES 暗号化して `connected_pages.page_access_token_encrypted` を UPDATE（Lambda 再デプロイ不要）|
| Anthropic API 障害 | DLQ 監視 → 障害ならスレッド画面は空入力で送信可能（FR-025）。手動でユーザーに事情説明 |
| 差し戻し対応 | 差し戻し理由を読み、動画の追補 or 実装修正で再提出 |
| 承認後 | `/speckit.tasks` → `/speckit.implement` で Phase 2 機能（AI 自動分類等）に着手 |

詳細は `docs/operations/audit-runbook.md` に記載する。

---

## 8. トラブルシューティング

### Webhook が届かない

1. Meta App Dashboard → Webhook ページで「Recent Deliveries」を確認
2. 401 が記録されている → 署名検証失敗（APP_SECRET の SSM 値を再確認）
3. タイムアウト → webhook-lambda のコールドスタート時間を確認、5 秒超えていたら要調査

### AI 下書きが生成されない

1. CloudWatch Logs で webhook-lambda → SQS enqueue が成功しているか確認
2. ai-worker-lambda の Logs で Anthropic API 呼び出しエラーを確認
3. DLQ にメッセージが溜まっていないか確認（Anthropic API キー失効、レート制限等）
4. `ai_drafts.error` カラムを Supabase ダッシュボードで確認

### Supabase が Pause された

1. Supabase ダッシュボードで Resume を実行（手動）
2. keep-alive Lambda の最終成功時刻 + 過去 7 日の Invocation 回数を CloudWatch Metrics で確認
3. EventBridge Rule（`rate(1 day)`）が有効か確認
4. SNS 通知が届いていなかった場合は通知系統（メール / Slack）の再点検

### Send API が 400 + code 190

- トークン失効。Graph API Explorer で新しい長期 Page Access Token を再取得し、SSM を更新。

### Send API が 400 + subcode 2018278

- 24 時間窓超過。MVP スコープでは対応不可、レビュワーに新しいメッセージを送ってもらう運用。

### CloudFront 経由で Webhook が届かない

- API Gateway へのルーティング設定を確認。`/api/*` は CloudFront の Origin Request Policy で全ヘッダー + Body を Pass through する必要あり。

---

## 9. 次のステップ

1. 本 Quickstart を踏まえて `/speckit.tasks` を実行し、実装タスク分解を生成（または既存 `tasks.md` を参照）
2. `/speckit.implement` で段階的に実装
3. Business Verification 承認待ちの間にインフラ・アプリを構築
4. すべての [審査提出前チェックリスト](#6-審査提出前チェックリスト) が埋まったら App Review 提出
