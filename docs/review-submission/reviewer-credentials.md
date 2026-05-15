# Reviewer Credentials & Test Instructions — Fumireply

> ⚠️ **このファイルにパスワード平文を書き込まないこと。** SSM Parameter Store から都度取得し、Meta 申請フォームの "App Review → Reviewer credentials" 欄に直接貼る運用とする。

**Reviewer-facing URL**: `https://review.fumireply.ecsuite.work`
**Login URL**: `https://review.fumireply.ecsuite.work/login`
**Reviewer email**: `reviewer@malbek.co.jp`

---

## 1. パスワード取得手順（運用者向け）

申請フォームに貼り付ける直前にローカルで取得する：

```bash
aws ssm get-parameter \
  --name /fumireply/review/supabase/reviewer-password \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text
```

取得後の運用ルール：

- ターミナル履歴に残さない（`history -d` で削除、または zsh の `setopt HIST_IGNORE_SPACE` で先頭スペースを使う）
- 申請フォームに貼ったら、ローカルに保存しない（メモアプリ・Slack DM 等含む）
- 結果通知後 24 時間以内にローテーション（後述）

---

## 2. レビュワーアカウントの状態管理（運用者向け）

| タイミング | 操作 | 担当 |
|---|---|---|
| **平常時** | Supabase ダッシュボードで `banned_until` を未来日（例: 2099-12-31）に設定 → ログイン不可 | Malbek 運用 |
| **申請提出 24 時間前** | `bash scripts/prep-screencast.sh` を実行（reviewer `banned_until = NULL` 化 + `connected_pages` の Malbek 行クリア + パスワードをクリップボードに取得 + health 200 確認）。手動で行う場合はパスワードを `openssl rand -base64 24` で再発行し SSM `/fumireply/review/supabase/reviewer-password` を `--overwrite` で更新 | Malbek 運用 |
| **申請提出時** | SSM から取得したパスワードを Meta 申請フォームに貼付 | Malbek 運用 |
| **審査結果通知後 24 時間以内** | 再度 `banned_until` を未来日にセット + パスワード再発行 + SSM 更新 | Malbek 運用 |

> ⚠️ **審査期間中（提出から結果通知まで）はパスワードを変更しないこと。** Meta 側の申請情報が無効化されると "Cannot reproduce" 差し戻しの原因になる。

詳細手順は `docs/operations/audit-runbook.md` および `specs/001-mvp-app-review/quickstart.md` §3.2 を参照。

---

## 3. Meta 申請フォームに貼り付けるテスト手順（英語、Reviewer credentials 欄）

> 以下を申請フォームの "Test User Credentials" / "Reviewer Instructions" 欄に貼る。`<<...>>` の各プレースホルダを提出直前に実値へ差し替える（パスワードは SSM、Page ID/名称は接続予定 Test Page、FB Test User パスワードは GitHub Actions secret `FB_TEST_USER_PASSWORD` から取得）。`<<...>>` 残存ゼロは T054 で grep 確認する。

```
=== App login credentials ===

Login URL:     https://review.fumireply.ecsuite.work/login
Email:         reviewer@malbek.co.jp
Password:      <<APP PASSWORD — paste from SSM>>

Two-factor authentication is disabled for this account during the review period.
The account does not require IP allow-listing.

=== Facebook Test User (for the Connect step's login dialog) ===

Facebook email:    <<FB TEST USER EMAIL — fill before submission>>
Facebook password: <<FB TEST USER PASSWORD — paste from secret>>

This is a Facebook Test User that manages the Test Page below. You will use it
in the Facebook Login for Business dialog during Step 2.

=== Test Facebook Page to connect ===

Page name:     <<TEST PAGE NAME — fill before submission>>
Page ID:       <<NUMERIC PAGE ID — fill before submission>>

The Page is NOT pre-connected. You will connect it yourself during the demo by
entering the numeric Page ID above. This is by design — the screencast and this
flow demonstrate the actual permission-grant experience.

=== End-to-end test scenario (~4 minutes) ===

Step 1. Sign in to the admin app
  - Go to https://review.fumireply.ecsuite.work/login
  - Use the App login credentials above
  - Because no Page is connected yet, you are redirected to
    /onboarding/connect-page

Step 2. Connect the Facebook Page (grants the 4 permissions)
  - Click "Connect Facebook Page"
  - A Facebook Login for Business dialog opens. Sign in with the Facebook
    Test User above if prompted, then grant the single consent dialog that
    lists all four permissions:
        pages_show_list, pages_manage_metadata,
        pages_read_engagement, pages_messaging
  - Back on our screen, enter the numeric Page ID from above and click
    "Connect"
  - Our server resolves the Page name + Page Access Token server-side and
    subscribes the Page to the messages / messaging_postbacks webhook.
    You are redirected to /inbox.

Step 3. Send a test Messenger message to the Page
  - Open the Messenger app on your phone (or the m.me link) as a customer
  - Send a short message such as: "Hi, do you have product X in stock?"
  - The conversation appears in the inbox within ~10 seconds (auto-poll)

Step 4. Open the conversation
  - Click the new conversation in the left list to open /threads/<id>
  - The header shows the customer's PSID and a "Within 24h window" badge
  - The reply textarea briefly shows "Draft is being generated..."
  - Within ~30 seconds, an AI-suggested draft is filled into the textarea by
    Anthropic's Claude Haiku 4.5 model (disclosed in our Privacy Policy)

Step 5. Edit and send
  - You can edit the draft freely (it is just a starting point)
  - Click the "Send" button to deliver the reply
  - Sending is a manual click action — there is no auto-send anywhere
  - Your phone Messenger app should receive the reply within 5 seconds

Step 6. Confirm public pages
  - Privacy Policy:    https://review.fumireply.ecsuite.work/privacy
  - Terms of Service:  https://review.fumireply.ecsuite.work/terms
  - Data Deletion:     https://review.fumireply.ecsuite.work/data-deletion

=== Notes for reviewers ===

- The UI is in English; a EN/JA toggle is in the header if needed.
- The Connect step uses Facebook Login for Business with a configuration that
  bundles all four permissions into one consent dialog. Tokens are exchanged
  and stored server-side; the Page Access Token is never exposed to the browser.
- The Send button is automatically disabled if the 24-hour standard messaging
  window has expired. We do not request pages_messaging_subscriptions.
- AI draft generation can be skipped — the textarea always accepts manually
  typed input and the Send button works without an AI draft.
- All Messenger message bodies are sent to Anthropic (Claude API) over HTTPS
  for the sole purpose of generating the draft. This is disclosed in the
  Privacy Policy linked above.
- The data deletion callback at POST /api/data-deletion follows Meta's signed
  request specification (HMAC-SHA256) and you can validate it via the
  "Send test" button in App Settings → Advanced → Data Deletion Request URL.
```

---

## 4. 審査直前の最終確認チェック（運用者向け）

申請フォーム送信ボタンを押す前に：

- [ ] `aws ssm get-parameter` で App パスワードが取得できる（または `scripts/prep-screencast.sh` がクリップボードに取得済み）
- [ ] FB Test User の email / password（secret `FB_TEST_USER_EMAIL` / `FB_TEST_USER_PASSWORD`）と接続予定 Test Page の数値 Page ID が手元にある
- [ ] 取得した App パスワードでブラウザの incognito から `/login` → **`/onboarding/connect-page` に強制リダイレクト**される（=未接続状態 = prep スクリプトが connected_pages をクリア済み）
- [ ] Connect → Login for Business 同意（4 権限が 1 ダイアログ）→ Page ID 入力 → `/inbox` 着地まで通る
- [ ] テスト FB ページから新規 Messenger メッセージを送ると 30 秒以内に AI 下書きが出る
- [ ] スレッドで Send ボタンをクリックすると Messenger 側に届く（5 秒以内）
- [ ] UI が英語表示（言語トグル EN）
- [ ] `/privacy` `/terms` `/data-deletion` がすべて 200
- [ ] Meta App Dashboard → App Settings → Advanced → Data Deletion Request URL の "Send test" が 200 を返す
- [ ] Webhook 購読が緑チェック
- [ ] reviewer の `banned_until` が NULL（=有効化済み）
- [ ] スクリーンキャスト動画が Unlisted で再生可能
- [ ] `<<...>>` プレースホルダ残存ゼロ（`grep -rn "<<.*>>" docs/review-submission/`）

すべて満たしたら、提出手順は [`submission-walkthrough.md`](./submission-walkthrough.md) に従って申請フォームを送信。
