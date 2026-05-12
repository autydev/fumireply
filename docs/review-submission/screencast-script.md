# Screencast Script — Fumireply Meta App Review

**Target length**: 3 分（最大 3 分 30 秒）
**Format**: 1920×1080, MP4 (H.264), 字幕は焼き込み（英語）
**Recording**: macOS QuickTime → DaVinci Resolve で字幕付与
**Upload**: YouTube 限定公開（Unlisted）→ 申請フォームに URL を貼付
**Reviewer-facing URL**: `https://review.fumireply.ecsuite.work`

---

## 撮影前チェック

- [ ] 画面録画解像度 1920×1080 / 60fps
- [ ] ブラウザは Chrome、ブックマークバー非表示・拡張機能アイコン非表示、**UI 言語は EN に切替済み**
- [ ] DevTools / 通知 / メール等の個人情報が映らない
- [ ] レビュワー用テストアカウント（`reviewer@malbek.co.jp`）を有効化済み（`banned_until = null`）
- [ ] **connected_pages テーブルのレビュワー用テナントの行を削除済み**（onboarding フローを見せるため）
- [ ] テスト FB ページ（Test User 所有）が存在し、FB.login で選択可能な状態
- [ ] スマホ実機（Messenger アプリ）と PC 画面を同時に撮影できるよう準備（OBS で 2 ソース合成）
- [ ] 公開ページ（`/privacy`, `/terms`, `/data-deletion`）が 200 で表示されることを事前確認

> **重要**: 録画中にメッセージを送るスマホは「Meta 側の顧客役」を演じるテストアカウントのみ使用すること。

---

## シーン構成（合計 3:00）

### Scene 1 — Intro（0:00〜0:15 / 15 秒）

**画面**: アプリ紹介スライド（タイトル: "Fumireply — AI-assisted Messenger inbox for Facebook Page operators"）

**ナレーション（英語字幕も同文）**:
> "Fumireply is an admin tool for Facebook Page operators. It lets a human operator receive incoming Messenger messages, see an AI-generated draft reply, and send it manually. We never auto-send. This screencast shows the full flow including the one-time Page connection and a live Messenger exchange."

**字幕**:
- 上部: `App: Fumireply`
- 下部: `Operated by Malbek Inc. — Cross-border e-commerce support`

---

### Scene 2 — Login（0:15〜0:30 / 15 秒）

**画面**: `https://review.fumireply.ecsuite.work/login` を Chrome で開く

**操作**:
1. URL バーに `review.fumireply.ecsuite.work/login` を打鍵 → Enter
2. Email 欄に `reviewer@malbek.co.jp` を入力
3. Password 欄に reviewer 用パスワードを入力（`•` でマスクされていることを確認）
4. "Sign in" ボタンをクリック
5. `/onboarding/connect-page` にリダイレクトされる（connected_pages 未登録のため）

**字幕**:
- `1. Operator signs in (Supabase Auth, JWT in HttpOnly Cookie)`
- `2. Redirected to onboarding — no Page connected yet`

---

### Scene 3 — Connect Facebook Page（0:30〜1:00 / 30 秒）

**画面**: `/onboarding/connect-page`

**操作**:
1. "Connect with Facebook" ボタンをクリック
2. FB.login ポップアップが開き、4 権限の同意ダイアログが表示される
   - `pages_messaging`, `pages_read_engagement`, `pages_manage_metadata`, `pages_show_list`
3. Test User アカウントでログイン → 全権限を許可
4. ポップアップが閉じ、ページ一覧が表示される（Test Page の名前と ID が見える）
5. Test Page を選択 → "Connect with Facebook" ボタンをクリック
6. `/inbox` にリダイレクト（接続完了）

**字幕**:
- `Permissions requested: pages_messaging, pages_read_engagement, pages_manage_metadata, pages_show_list`
- `Page Access Token encrypted (AES-256-GCM) server-side — never sent to browser`
- `Webhook subscribed: POST /{pageId}/subscribed_apps (pages_manage_metadata)`

---

### Scene 4 — Inbox view（1:00〜1:20 / 20 秒）

**画面**: `/inbox` 受信トレイ

**操作**:
1. 左側に Conversation list（テスト顧客からの既存メッセージが表示される）
2. 各行に「customer 名 / PSID / 最新メッセージ抜粋 / 未読バッジ / 24h 窓状態」が見えることをカーソルで指す
3. フィルタ（all / unread / draft / overdue）を一度クリックしてみせる

**字幕**（このシーン中ずっと表示）:
- 上部固定: `Permission used here: pages_read_engagement`
- 下部: `Incoming Messenger messages (received via Webhook on /api/webhook) are listed here in real time.`

---

### Scene 5 — Send a fresh test message（1:20〜1:40 / 20 秒）

**画面**: PC 画面（左半分: inbox / 右半分: スマホ実機 Messenger アプリの画面共有）

**操作**:
1. スマホの Messenger アプリでテスト FB ページを開く
2. "Hi, do you have this product in stock?" と入力 → 送信
3. 7 秒以内に PC 側の inbox に新規 conversation 行が出現することを確認
4. 該当行をクリック → `/threads/$id` に遷移

**字幕**:
- `Permission used here: pages_messaging (webhook subscription) + pages_manage_metadata`
- `Webhook → DB insert → SQS enqueue → AI draft worker (Anthropic Claude)`

---

### Scene 6 — AI draft display（1:40〜2:05 / 25 秒）

**画面**: スレッド詳細画面 `/threads/$id`

**操作**:
1. ヘッダーに customer 名 / PSID / `24h window` バッジが表示されていることを確認
2. メッセージリストに直前の "Hi, do you have this product in stock?" が表示
3. 下部の reply form に `Generating draft...` バナーが一瞬出る
4. 数秒以内に AI suggestion カードが表示され、textarea に下書きが自動投入される
5. カード上部の `✨ AI suggestion` ラベル、👍/👎 フィードバックボタンを指す

**字幕**:
- 上部固定: `AI generates a draft only — humans always click Send.`
- 下部: `Customer message body is sent to Anthropic Claude Haiku 4.5 over HTTPS. Disclosed in Privacy Policy.`

---

### Scene 7 — Edit and send（2:05〜2:35 / 30 秒）

**画面**: 同じスレッド画面

**操作**:
1. textarea にカーソルを置き、AI 下書きの末尾を 1 行追記
2. **Send ボタンを明確にカーソルでホバー → クリック**（このフレームを 1 秒静止）
3. 送信完了後、textarea がクリアされ、メッセージリストに送信内容が outbound として追加
4. スマホ Messenger アプリ側にも返信メッセージが届いていることを確認

**字幕**（送信ボタンクリック時に強調表示）:
- 大きく: `🖱️ Human clicks Send — no auto-send.`
- 補足: `Permission used here: pages_messaging (Send API: POST graph.facebook.com/v19.0/me/messages)`

---

### Scene 8 — Closing（2:35〜3:00 / 25 秒）

**画面**: 公開ページを順に切り替え（各 5〜7 秒）
1. `/privacy` のスクロール（"Anthropic, Inc." の段落をハイライト）
2. `/data-deletion`（削除手順）
3. `/terms`

**字幕**:
- `All public pages served on https://review.fumireply.ecsuite.work over HTTPS.`
- `Data Deletion endpoint: POST https://review.fumireply.ecsuite.work/api/data-deletion`
- `Anthropic disclosure is included in our Privacy Policy.`

**ナレーション**:
> "All required pages are HTTPS, the privacy policy discloses Anthropic as a sub-processor, and our data deletion endpoint complies with Meta's signed-request callback spec. Thank you for reviewing."

---

## 録画後チェック

- [ ] 全字幕が読みやすい位置・サイズか（最低 24pt 推奨）
- [ ] パスワード文字列・JWT 文字列・Cookie 値・SSM パスがフレーム内に映っていないか確認（ある場合は黒塗り）
- [ ] 個人ユーザーの実 PSID / 実名が映っていないか
- [ ] 動画ファイルサイズ 100 MB 以下、長さ 3 分 30 秒以内
- [ ] YouTube アップロード時 "Unlisted（限定公開）"、コメント無効化、年齢制限なし
- [ ] アップロード後、シークレットウィンドウで URL 直叩きで再生可能か確認

---

## ナレーション台本（英語版・読み上げ用、合計 ~300 words）

> Hi, this is a screencast for the Fumireply Messenger admin tool, applying for `pages_messaging`, `pages_read_engagement`, `pages_manage_metadata`, and `pages_show_list`.
>
> The operator signs in to our admin panel at review.fumireply.ecsuite.work using a Supabase-managed account. Two-factor authentication is disabled for the duration of review per Meta's reviewer guideline.
>
> Since no Facebook Page is connected yet, the operator is redirected to the onboarding screen. They click "Connect with Facebook", which opens the Facebook Login dialog. All four permissions are requested at once and the operator grants them. Our server exchanges the short-lived token for a long-lived one, calls the Graph API to list the operator's Pages, and displays the results. The operator selects the Test Page. Our server subscribes the webhook and stores the encrypted Page Access Token. The operator is now in the inbox.
>
> The inbox shows incoming Messenger conversations received from the connected Page via webhook. This uses `pages_read_engagement`.
>
> Now I'll send a test message from a Messenger user to the connected Page. The webhook delivers it within seconds and the inbox updates automatically. This uses `pages_manage_metadata` for the webhook subscription.
>
> Opening the conversation, you'll see a draft being generated. The customer's message body is sent to Anthropic's Claude Haiku 4.5 model over HTTPS — this is disclosed in our Privacy Policy. The AI returns a suggested reply, which is placed into the reply box.
>
> Critically: this is just a suggestion. The operator reads the draft, edits it, and explicitly clicks the Send button. There is no auto-send anywhere in the flow. The Send action calls the Send API using `pages_messaging`.
>
> The customer immediately receives the reply on Messenger.
>
> Finally, all required public pages — privacy, terms, and data deletion — are served at the same domain over HTTPS. The privacy policy discloses Anthropic as our sub-processor. Our data deletion endpoint complies with Meta's signed-request specification.
>
> Thank you for reviewing.
