# Quickstart: App Review Submission Readiness

**Feature**: `002-app-review-submission`
**Audience**: 002 ブランチで実装を始める開発者 / 提出担当者
**Updated**: 2026-05-06

> **前提**: `001-mvp-app-review` の quickstart 手順（Supabase / SSM / Terraform / DB マイグレーション / reviewer ユーザー作成）は**完了済み**であること。本 quickstart は 001 完了状態に対する**差分セットアップ**のみを記載する。

---

## 0. 前提環境

| 項目 | 状態 |
|---|---|
| 001-mvp-app-review が main にマージ済み | 必須 |
| `https://review.fumireply.ecsuite.work` 本番デプロイ稼働中 | 必須 |
| Meta App Dashboard で App ID 発行済み | 必須 |
| Business Verification | 申請中 or 承認済み |
| `connected_pages` に Malbek tenant 用の seed 行が **存在する**（001 セットアップ済み）| 撮影前に削除する想定 |
| node_modules が最新（`npm ci` 済み） | 推奨 |

---

## 1. ブランチ作成と依存追加

```bash
# 002 ブランチ（speckit-git-feature が既に作成済み）
git checkout 002-app-review-submission

# Paraglide JS 依存
cd app
npm install --save-dev @inlang/paraglide-js
```

> Facebook JS SDK は npm で入れない。クライアント側で動的 import する（contracts/connect-page-fn.md §3 のクライアントフロー参照）。

---

## 2. Paraglide 初期セットアップ

### 2.1 公式 example を参照

```bash
# 別ディレクトリで example を 1 度だけ clone
cd /tmp
git clone --depth=1 https://github.com/TanStack/router
open router/examples/react/start-i18n-paraglide
```

`vite.config.ts`、`project.inlang/settings.json`、`messages/{en,ja}.json` の構成を確認する。

### 2.2 fumireply 側の設定

```bash
cd /Users/ssdef/program/fumireply/app
mkdir -p messages project.inlang
```

- `app/project.inlang/settings.json` を作成（contracts/locale-fn.md §4 の例参照）
- `app/messages/en.json` と `app/messages/ja.json` を作成（同 §4 の例参照）
- `app/vite.config.ts` に `paraglide-js` Vite plugin を追加（公式 example 準拠）

### 2.3 初回 compile

```bash
npx paraglide-js compile --project ./project.inlang
# → app/paraglide/runtime.ts と messages/*.ts が生成される
```

### 2.4 .gitignore 更新

```bash
echo "app/paraglide/" >> /Users/ssdef/program/fumireply/.gitignore
```

`messages/*.ts`（生成物）も gitignore したいが、`messages/{en,ja}.json` は **コミット対象**。

### 2.5 動作確認

`app/src/routes/__root.tsx` で動作確認用に `m.login_submit_button()` を呼んで画面に表示し、Cookie `fumireply_locale=en` を手動で付けてリロードすると英訳が出ることを確認。

---

## 3. Facebook App 設定

### 3.1 Allowed Domains に本番ドメインを追加

1. Meta for Developers → 該当 App → Settings → Basic
2. **App Domains** に `review.fumireply.ecsuite.work` を追加
3. **Add Platform** → Website → **Site URL**: `https://review.fumireply.ecsuite.work/`

### 3.2 Login Settings

1. Products → Facebook Login → Settings
2. **Valid OAuth Redirect URIs**: 本機能では JS SDK ポップアップを使うため redirect URI は不要だが、Meta が空欄を許さない場合は `https://review.fumireply.ecsuite.work/login` を仮置き
3. **Embedded Browser OAuth Login**: Yes
4. **Use Strict Mode for Redirect URIs**: Yes

### 3.3 環境変数

`app/.env.local`（ローカル開発）と Lambda env（本番）に以下を追加：

| 変数名 | 値 |
|---|---|
| `VITE_FB_APP_ID` | Meta App ID（Settings → Basic で確認） |

App Secret は SSM `/fumireply/review/meta/app-secret` から server fn 内で取得（既存）。

### 3.4 テスト FB User の作成

E2E と手動撮影練習用：

1. Meta for Developers → 該当 App → Roles → **Test Users**
2. **Add** → Create New Account（「Authorize Test Users to use this app」を ON）
3. 作成された Test User でブラウザログイン → Test User 用の Facebook Page を 1 つ作成（テスト用に "Fumireply E2E Test Page" 等）
4. Test User の認証情報を GitHub Actions secrets `FB_TEST_USER_EMAIL` / `FB_TEST_USER_PASSWORD` / `FB_TEST_PAGE_ID` に保管

---

## 4. ローカル開発の起動

```bash
cd /Users/ssdef/program/fumireply/app
npm run dev
```

- `http://localhost:3000/login` でログイン
- 既存 Malbek tenant にログインすると `connected_pages` の seed 行があるため `/inbox` に直行する
- Connect Page フローを試したい場合：

  ```bash
  # 一時的に DB の connected_pages を削除（再 seed 可能）
  psql "$DATABASE_URL" -c "DELETE FROM connected_pages WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'malbek');"
  ```

  その後再度 `/inbox` に行くと `/onboarding/connect-page` に redirect される。

---

## 5. テスト実行

### 5.1 unit + integration（vitest）

```bash
cd app
npm test
# 002 で追加：tests/integration/connect-page.test.ts, tests/integration/locale-toggle.test.ts
```

### 5.2 E2E（Playwright）

```bash
cd app
FB_TEST_USER_EMAIL=... FB_TEST_USER_PASSWORD=... npm run test:e2e
# 002 で追加：tests/e2e/connect-page-flow.spec.ts
```

### 5.3 Paraglide 翻訳キー同期チェック

```bash
cd app
npx paraglide-js compile --project ./project.inlang
git diff --exit-code messages/
# → diff が出る = 未コミットの翻訳変更あり
```

CI（`.github/workflows/ci.yml`）に同様のステップを追加して PR で検出する。

---

## 6. 撮影前 prep スクリプトの使い方

### 6.1 実行

```bash
# 本番 reviewer 有効化 + connected_pages 削除
bash scripts/prep-screencast.sh
```

スクリプトは以下を実行する（詳細は research.md R-010）：

1. AWS CLI / Supabase 接続情報の存在確認
2. SSM から reviewer パスワード取得（macOS のクリップボードに `pbcopy`）
3. Supabase Admin API で reviewer の `banned_until = NULL`
4. `DELETE FROM connected_pages WHERE tenant_id = 'malbek-uuid'`
5. 公開ページ・管理画面・Webhook の 200 ヘルスチェック
6. 監査ログ append（`docs/operations/audit-runbook.md`）

### 6.2 撮影完了後の cleanup

```bash
bash scripts/post-screencast.sh
```

reviewer 無効化 + 撮影で生じた一時データの整理（research.md R-011）。

---

## 7. 申請ドキュメントの最終化

### 7.1 必須 4 ファイル

| ファイル | 状態 | 002 での作業 |
|---|---|---|
| `docs/review-submission/use-case-description.md` | 001 ドラフトあり | Connect Page フロー追加・EN UI 前提・タイムスタンプ参照を反映、英文を最終化 |
| `docs/review-submission/screencast-script.md` | 001 ドラフトあり | 全シーン EN UI 前提に書き直し、Connect Page シーンを追加 |
| `docs/review-submission/reviewer-credentials.md` | 001 ドラフトあり | Connect Page フロー反映、SSM 取得手順は維持 |
| `docs/review-submission/submission-walkthrough.md` | 未作成 | 新規作成（Meta App Dashboard 操作手順、提出ボタン押下までのフロー、最終チェックリスト） |

### 7.2 確認

```bash
# プレースホルダー残存チェック
grep -r "<<.*>>" docs/review-submission/
# → 何も出ないことを確認

# URL 200 チェック
for u in \
  https://review.fumireply.ecsuite.work \
  https://review.fumireply.ecsuite.work/privacy \
  https://review.fumireply.ecsuite.work/terms \
  https://review.fumireply.ecsuite.work/data-deletion \
  https://review.fumireply.ecsuite.work/login; do
    echo -n "$u → "
    curl -o /dev/null -s -w "%{http_code}\n" "$u"
done
# → すべて 200
```

---

## 8. デプロイ手順（既存パイプライン継続）

001 と同じ手順：

```bash
# Lambda パッケージ再ビルド
npm run build --prefix app

# 既存パイプラインで deploy
npm run deploy:review
```

新規 Lambda・新規 SSM パラメータの追加なし。Terraform diff はゼロを期待。

---

## 9. screencast 撮影の手順（人間作業）

1. `bash scripts/prep-screencast.sh` で前提条件を整える
2. macOS QuickTime で全画面録画開始
3. Chrome incognito で `https://review.fumireply.ecsuite.work/login` を開く
4. EN モードに切替（Header の `EN` をクリック）
5. ログアウト状態 → ログイン → /onboarding/connect-page → Facebook Login → ページ選択 → /inbox → スマホ Messenger からテストメッセージ送信 → AI 下書き表示 → 編集 → 送信、までを通しで操作
6. `bash scripts/post-screencast.sh` で reviewer 無効化等の cleanup
7. 録画ファイルを CapCut / iMovie で字幕付加 → MP4 export
8. YouTube に Unlisted でアップロード → URL を控える
9. URL を `submission-walkthrough.md` の指示に従って Meta App Dashboard に貼付

---

## 10. 提出フロー

`docs/review-submission/submission-walkthrough.md`（002 で新規作成）の手順に従う：

1. Meta App Dashboard → App Review → Permissions and Features
2. 各権限欄に use-case-description.md の本文を貼付（権限 4 つ）
3. screencast YouTube URL を 4 か所に貼付（同一動画）
4. Reviewer credentials を貼付（reviewer-credentials.md の英語ブロック）
5. 最終チェックリスト（submission-walkthrough.md 末尾）を全項目確認
6. Submit ボタンクリック
7. 申請 ID を控える

---

## 11. 提出後の運用

001 で構築した `docs/operations/audit-runbook.md` に従う：

- CloudWatch アラームの監視（既存）
- Supabase keep-alive 確認（既存）
- 差し戻し対応（既存）
- 結果通知後の reviewer ローテーション（既存）

本 002 機能による追加の運用負担は無し。

---

## 12. トラブルシューティング

### Paraglide の生成物が壊れる

```bash
cd app
rm -rf paraglide/
npx paraglide-js compile --project ./project.inlang
```

### Facebook Login でポップアップが開かない

- Chrome のポップアップブロッカー設定を確認
- Allowed Domains に `review.fumireply.ecsuite.work` が登録されているか
- App ID（VITE_FB_APP_ID）が正しいか

### `/me/accounts` が空配列

- Test User が Page を持っていない可能性。Facebook for Business で Page 作成済みか確認

### Webhook 購読が成功しているのに inbox にメッセージが来ない

- Meta App Dashboard → Webhooks → 該当ページに緑チェックがあるか
- Webhook Lambda の CloudWatch Logs を確認（既存 001 トラブルシューティング）

### prep-screencast.sh が `connected_pages` 削除に失敗

- DB 接続情報（DATABASE_URL）が SSM から正しく取れているか
- `withTenant` 経由で削除する必要があるか確認（直接 DELETE で OK な現状）
