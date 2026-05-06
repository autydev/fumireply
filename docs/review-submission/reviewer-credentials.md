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
| **申請提出 24 時間前** | `banned_until = NULL` に変更 → ログイン可能化 + パスワードを `openssl rand -base64 24` で再発行 → SSM `/fumireply/review/supabase/reviewer-password` を `--overwrite` で更新 | Malbek 運用 |
| **申請提出時** | SSM から取得したパスワードを Meta 申請フォームに貼付 | Malbek 運用 |
| **審査結果通知後 24 時間以内** | 再度 `banned_until` を未来日にセット + パスワード再発行 + SSM 更新 | Malbek 運用 |

> ⚠️ **審査期間中（提出から結果通知まで）はパスワードを変更しないこと。** Meta 側の申請情報が無効化されると "Cannot reproduce" 差し戻しの原因になる。

詳細手順は `docs/operations/audit-runbook.md` および `specs/001-mvp-app-review/quickstart.md` §3.2 を参照。

---

## 3. Meta 申請フォームに貼り付けるテスト手順（英語、Reviewer credentials 欄）

> 以下を申請フォームの "Test User Credentials" / "Reviewer Instructions" 欄に貼る。`<<PASSWORD>>` の部分を SSM から取得した最新パスワードに差し替える。

```
=== Test credentials ===

Login URL:     https://review.fumireply.ecsuite.work/login
Email:         reviewer@malbek.co.jp
Password:      <<PASSWORD — paste from SSM>>

Two-factor authentication is disabled for this account during the review period.
The account does not require IP allow-listing.

=== Connected test Facebook Page ===

Page name:     <<TEST PAGE NAME — fill before submission>>
Page ID:       <<NUMERIC PAGE ID — fill before submission>>

This Page is already connected to the Fumireply admin account in our database.
You do not need to perform any OAuth flow. After signing in, the inbox will
already be subscribed to the Page's Messenger webhook.

=== End-to-end test scenario (~3 minutes) ===

Step 1. Sign in
  - Go to https://review.fumireply.ecsuite.work/login
  - Use the credentials above
  - You will be redirected to /inbox

Step 2. Send a test Messenger message to our Page
  - Open the Messenger app on your phone (or m.me link)
  - Send a short message such as: "Hi, do you have product X in stock?"
  - The conversation appears in the inbox within ~10 seconds (auto-poll)

Step 3. Open the conversation
  - Click the new conversation in the left list to open /threads/<id>
  - The conversation header shows the customer's PSID and a "24h window" badge
  - The reply textarea will briefly show "Draft is being generated..."
  - Within ~30 seconds, an AI-suggested draft is filled into the textarea by
    Anthropic's Claude Haiku 4.5 model (this is disclosed in our Privacy Policy)

Step 4. Edit and send
  - You can edit the draft freely (it is just a starting point)
  - Click the "送信" (Send) button to deliver the reply
  - Sending is a manual click action — there is no auto-send anywhere
  - Your phone Messenger app should receive the reply within 5 seconds

Step 5. Confirm public pages
  - Privacy Policy:    https://review.fumireply.ecsuite.work/privacy
  - Terms of Service:  https://review.fumireply.ecsuite.work/terms
  - Data Deletion:     https://review.fumireply.ecsuite.work/data-deletion

=== Notes for reviewers ===

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

- [ ] `aws ssm get-parameter` でパスワードが取得できる
- [ ] 取得したパスワードでブラウザの incognito から `/login` → `/inbox` に遷移できる
- [ ] テスト FB ページから新規 Messenger メッセージを送ると 30 秒以内に AI 下書きが出る
- [ ] スレッドで送信ボタンをクリックすると Messenger 側に届く（5 秒以内）
- [ ] `/privacy` `/terms` `/data-deletion` がすべて 200
- [ ] Meta App Dashboard → App Settings → Advanced → Data Deletion Request URL の "Send test" が 200 を返す
- [ ] Webhook 購読が緑チェック
- [ ] reviewer の `banned_until` が NULL（=有効化済み）
- [ ] スクリーンキャスト動画が Unlisted で再生可能

すべて満たしたら申請フォームを送信。
