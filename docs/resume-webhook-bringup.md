# Meta Webhook 登録 bring-up — 作業メモ (2026-05-04)

Meta App Dashboard で Webhook の Callback URL 登録が通らないので、その bring-up 中。

## 現在地（一言）

API Gateway 直叩きは **200 + test123** で疎通済み。**CloudFront 経由のときだけ 403** が返る状態で詰まっている。残るは CloudFront 側の調査・修正のみ。

## Meta UI に入れる値

| 入力欄 | 値 |
|---|---|
| Callback URL | `https://review.fumireply.ecsuite.work/api/webhook` |
| Verify Token | SSM `/fumireply/review/meta/webhook-verify-token` の値 |
| Subscription Fields | `messages`, `messaging_postbacks` |

Verify Token を取り出すコマンド:

```bash
aws ssm get-parameter \
  --name /fumireply/review/meta/webhook-verify-token \
  --with-decryption --query Parameter.Value --output text
```

## 今日ここまでにやったこと（時系列）

1. **解説 HTML 作成**: `docs/explanations/e2e-meta-testing.html`
   - Messenger には WhatsApp 的サンドボックスは無い、Dev Mode + Tester Role が代替
   - 既存 4 ページ（supabase-auth / meta-tokens / webhook / seed）のパンくずに新ページのリンクも追加
2. **CloudFront のドメイン確認**: 代替ドメイン `review.fumireply.ecsuite.work` が ACM 証明書付きで稼働済み。Webhook URL に採用
3. **GitHub Actions OIDC の bring-up**:
   - `vars.AWS_DEPLOY_ROLE_ARN` と `vars.CLOUDFRONT_DISTRIBUTION_ID` を GitHub Repository Variables に登録（OIDC なので長期キーは不要）
4. **Lambda zip が空（204 byte placeholder）問題を修正**:
   - `vite.config.ts` に `nitro()` プラグインを追加（`.output/server/index.mjs` を生成させるため）
   - `npm install nitro` で依存追加
5. **IAM 権限不足を修正**:
   - `terraform/modules/github-actions-oidc/` に `lambda_artifacts_bucket_arn` 変数 + `LambdaArtifactsS3Upload` Statement 追加
   - `terraform/envs/review/main.tf` でモジュールに渡すよう接続
   - `terraform apply -target=module.github_actions_oidc` 済み
6. **deploy-app.yml のアセットパス修正**:
   - `_build/*` → `assets/*` に変更（TanStack Start 1.167+ + nitro の出力構造に合わせて）
7. **デプロイ完走確認**: 4 Lambda + S3 sync + CloudFront invalidation すべて通った
8. **疎通テスト結果**:
   - `curl <APIGW直>/api/webhook?hub.mode=subscribe&...` → ✅ **200 + `test123`**（content-length: 7）
   - `curl https://review.fumireply.ecsuite.work/api/webhook?...` → ❌ **403 ForbiddenException** (CloudFront 経由)

## 詰まっているところ

CloudFront 経由のときだけ API Gateway 「ルート未マッチ」と同じ 403 が返ってくる。考えられる原因:

- **A) 古い 403 がエラーキャッシュに残っている**（deploy 前に Lambda が `Cannot find module 'handler'` で落ちていた時のレスポンス）
- **B) CloudFront のオリジン設定が古い API Gateway を指している**

## 明日の最初の一手

### A から試す（即効性あり）

```bash
aws cloudfront create-invalidation \
  --distribution-id E1BVZ9FF47RUPT \
  --paths "/api/*"

# 30 秒〜2 分待ってから再試行
TOKEN=$(aws ssm get-parameter \
  --name /fumireply/review/meta/webhook-verify-token \
  --with-decryption --query Parameter.Value --output text)

curl -i "https://review.fumireply.ecsuite.work/api/webhook?hub.mode=subscribe&hub.verify_token=$TOKEN&hub.challenge=test123"
```

`200 + test123` が返ったら → 原因 A 確定 → そのまま Meta UI で `Verify and Save`

### A で治らなければ B の確認

```bash
# CloudFront が見ているオリジン
CF_ORIGIN=$(aws cloudfront get-distribution \
  --id E1BVZ9FF47RUPT \
  --query "Distribution.DistributionConfig.Origins.Items[?Id=='APIGW-fumireply-review'].DomainName | [0]" \
  --output text)
echo "CloudFront origin: $CF_ORIGIN"

# 直叩きで通った API Gateway
cd /Users/ssdef/program/fumireply/terraform/envs/review
APIGW_HOST=$(terraform output -raw api_gateway_invoke_url | sed -E 's|https://||')
echo "Terraform: $APIGW_HOST"
```

ズレていれば:

```bash
cd /Users/ssdef/program/fumireply/terraform/envs/review
terraform apply -target=module.static_site
```

## Meta UI 登録後の追加作業

Webhook URL 登録が通ったら、`docs/explanations/e2e-meta-testing.html` の §4「事前準備」のステップ 7-8 に進む:

- Test Page を Webhook 購読対象に追加（Messenger → Webhooks → Page サブスクリプション）
- Customer Tester（B 役）の FB アカウントに Tester Role 招待 → 承諾
- 実機 E2E（B から DM → 受信一覧に表示 → AI 下書き → 送信 → 着信）

## 関連ファイル（このセッションで変更）

- `app/vite.config.ts` — `nitro()` プラグイン追加
- `app/package.json` / `package-lock.json` — `nitro` 依存追加
- `.github/workflows/deploy-app.yml` — `_build/` → `assets/`
- `terraform/modules/github-actions-oidc/main.tf` — `LambdaArtifactsS3Upload` Statement 追加
- `terraform/modules/github-actions-oidc/variables.tf` — `lambda_artifacts_bucket_arn` 変数追加
- `terraform/envs/review/main.tf` — モジュール呼び出しに `lambda_artifacts_bucket_arn` 接続
- `specs/001-mvp-app-review/tasks.md` — 提出後 TODO 2 件追加（LWA → aws-lambda preset 移行 / `/_build/*` 死コード削除）
- `docs/explanations/e2e-meta-testing.html` — 新規（Messenger E2E ガイド）

## Phase 2 で着手する TODO（提出後）

`specs/001-mvp-app-review/tasks.md` 末尾に記載済み:

1. **Lambda Web Adapter → Nitro `aws-lambda` preset 移行**
   - 現状の `node-server` + LWA 構成は古い vinxi 時代の慣習を引きずった代替パターン
   - 2026-05 時点の各社公式（Vercel / SST / Thunder / Konings 参考実装）はすべて `aws-lambda` preset 直接
   - 移行時は `setCookie` 既知バグ（TanStack/router#3796）回避のため `streaming: false` 固定
2. **CloudFront の `/_build/*` ordered_cache_behavior 削除**（死コード化している）

## 重要な前提知識（忘れがち）

- **App Mode は Development のままで OK**: 実顧客対応には Live Mode + Advanced Access（App Review 通過後）が必要だが、今は Tester Role を持つ FB アカウントとの実機テスト用なので Dev Mode 据え置き
- **Page admin は自 Page に DM 投げられない**: 必ず別アカウント（B役）から送る。手元に 2 アカウント要
- **Verify Token は全テナント共通**: Meta App は 1 つのため。`connected_pages.webhook_verify_token_ssm_key` も同じ SSM パスを指す
