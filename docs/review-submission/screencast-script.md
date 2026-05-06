# Screencast Script — Fumireply Meta App Review

**Target length**: 2 分 30 秒（最大 3 分）
**Format**: 1920×1080, MP4 (H.264), 字幕は焼き込み（英語）
**Recording**: macOS QuickTime → DaVinci Resolve で字幕付与
**Upload**: YouTube 限定公開（Unlisted）→ 申請フォームに URL を貼付
**Reviewer-facing URL**: `https://review.fumireply.ecsuite.work`

---

## 撮影前チェック

- [ ] 画面録画解像度 1920×1080 / 60fps
- [ ] ブラウザは Chrome、ブックマークバー非表示・拡張機能アイコン非表示
- [ ] DevTools / 通知 / メール等の個人情報が映らない
- [ ] テスト FB ページに 24 時間以内の inbound メッセージが既に 1〜2 件届いている
- [ ] レビュワー用テストアカウント（`reviewer@malbek.co.jp`）を有効化済み（`banned_until = null`）
- [ ] スマホ実機（Messenger アプリ）と PC 画面を同時に撮影できるよう準備（OBS で 2 ソース合成）
- [ ] 公開ページ（`/privacy`, `/terms`, `/data-deletion`）が 200 で表示されることを事前確認

> **重要**: 録画中にメッセージを送るスマホは「Meta 側の顧客役」を演じるテストアカウントのみ使用すること。本番ユーザーのメッセージが映り込むと差し戻しの原因になる。

---

## シーン構成（合計 2:30）

### Scene 1 — Intro（0:00〜0:15 / 15 秒）

**画面**: アプリ紹介スライド（タイトル: "Fumireply — AI-assisted Messenger inbox for Facebook Page operators"）

**ナレーション（英語字幕も同文）**:
> "Fumireply is an admin tool for Facebook Page operators. It lets a human operator review incoming Messenger messages, see an AI-generated draft reply, and send it manually. We never auto-send. This screencast shows the full Messenger flow we use the requested permissions for."

**字幕**:
- 上部: `App: Fumireply`
- 下部: `Operated by Malbek Inc. — Cross-border e-commerce support`

---

### Scene 2 — Login（0:15〜0:30 / 15 秒）

**画面**: `https://review.fumireply.ecsuite.work/login` を Chrome で開く

**操作**:
1. URL バーに `review.fumireply.ecsuite.work/login` を打鍵 → Enter
2. Email 欄に `reviewer@malbek.co.jp` を入力
3. Password 欄に reviewer 用パスワードを入力（タイプ中はパスワード文字が `•` でマスクされていることを確認）
4. "Sign in" ボタンをクリック
5. `/inbox` にリダイレクトされる

**字幕**:
- `1. Operator signs in (Supabase Auth, JWT in HttpOnly Cookie)`
- `2. No 2FA / no IP restriction during review (per Meta reviewer guideline)`

---

### Scene 3 — Inbox view（0:30〜0:50 / 20 秒）

**画面**: `/inbox` 受信トレイ

**操作**:
1. 左側に Conversation list（テスト顧客からの未読メッセージが上に表示される）
2. 各行に「customer 名 / PSID / 最新メッセージ抜粋 / 未読バッジ / 24h 窓状態」が見えることをカーソルで指す
3. フィルタ（all / unread / draft / overdue）を一度クリックしてみせる

**字幕**（このシーン中ずっと表示）:
- 上部固定: `Permission used here: pages_read_engagement`
- 下部: `Incoming Messenger messages (received via Webhook on /api/webhook) are listed here in real time.`

**ナレーション（任意）**:
> "Each row is a Messenger conversation received via the webhook subscription. Unread count and 24-hour window status are tracked per conversation."

---

### Scene 4 — Send a fresh test message from Messenger（0:50〜1:10 / 20 秒）

**画面**: PC 画面（左半分: inbox / 右半分: スマホ実機 Messenger アプリの画面共有）

**操作**:
1. スマホの Messenger アプリでテスト FB ページを開く
2. "Hi, do you have this product in stock?" と入力 → 送信
3. 7 秒以内に PC 側の inbox に新規 conversation 行が出現することを確認（ポーリング 7 秒間隔）
4. 該当行をクリック → `/threads/$id` に遷移

**字幕**:
- `Permission used here: pages_messaging (subscription) + pages_manage_metadata (webhook subscription)`
- `Webhook → DB insert → SQS enqueue → AI draft worker (Anthropic Claude)`

---

### Scene 5 — AI draft display（1:10〜1:35 / 25 秒）

**画面**: スレッド詳細画面 `/threads/$id`

**操作**:
1. ヘッダーに customer 名 / PSID / `24h窓内` バッジが表示されていることを確認
2. メッセージリストに直前の "Hi, do you have this product in stock?" が表示
3. 下部の reply form に `Draft is being generated…` のバナー（DraftBanner）が一瞬出る
4. 数秒以内に AI suggestion カードが表示され、textarea に下書きが自動投入される
5. カード上部の `✨ AI suggestion` ラベル、👍/👎 フィードバックボタンを指す

**字幕**:
- 上部固定: `AI generates a draft only — humans always click Send.`
- 下部: `Customer message body is sent to Anthropic Claude Haiku 4.5 over HTTPS. This is disclosed in the Privacy Policy.`

**ナレーション**:
> "Within seconds, an AI draft appears in the reply box. The draft is just a suggestion — the operator must review, edit if needed, and explicitly click Send."

---

### Scene 6 — Edit and send（1:35〜2:05 / 30 秒）

**画面**: 同じスレッド画面

**操作**:
1. textarea にカーソルを置き、AI 下書きの末尾を 1 行追記（例: "Let me know your preferred shipping option." を足す）
2. footer に `下書き保存済` ピル（自動保存済バッジ）が表示されることを指す
3. **Send ボタンを明確にカーソルでホバー → クリック**（このフレームを 1 秒静止）
4. 送信完了後、textarea がクリアされ、メッセージリストに送信内容が `outbound` として追加されることを確認
5. スマホ Messenger アプリ側にも返信メッセージが届いていることを確認（5 秒以内）

**字幕**（送信ボタンクリック時に強調表示）:
- 大きく: `🖱️ Human clicks Send — no auto-send.`
- 補足: `Permission used here: pages_messaging (Send API call to graph.facebook.com/v19.0/me/messages)`

---

### Scene 7 — Closing（2:05〜2:30 / 25 秒）

**画面**: 公開ページを順に切り替え（各 5 秒）
1. `/privacy` のスクロール（"Anthropic, Inc." の段落をハイライト）
2. `/data-deletion`（削除手順）
3. `/terms`

**字幕**:
- `All public pages served on https://review.fumireply.ecsuite.work over HTTPS.`
- `Data Deletion endpoint: POST https://review.fumireply.ecsuite.work/api/data-deletion`
- `Anthropic disclosure is included in our Privacy Policy.`

**ナレーション（クロージング）**:
> "All required pages are HTTPS, the privacy policy discloses Anthropic as a sub-processor, and our data deletion endpoint complies with Meta's signed-request callback spec. Thank you for reviewing."

---

## 録画後チェック

- [ ] 全字幕が読みやすい位置・サイズか（最低 24pt 推奨）
- [ ] パスワード文字列・JWT 文字列・Cookie 値・SSM パスがフレーム内に映っていないか確認（ある場合は黒塗り）
- [ ] 個人ユーザーの実 PSID / 実名が映っていないか
- [ ] 動画ファイルサイズ 100 MB 以下、長さ 3 分以内
- [ ] YouTube アップロード時 "Unlisted（限定公開）"、コメント無効化、年齢制限なし
- [ ] アップロード後、シークレットウィンドウで URL 直叩きで再生可能か確認
- [ ] 字幕翻訳が必要な場合は YouTube のクローズドキャプション機能で英語 SRT を別添

---

## ナレーション台本（英語版・読み上げ用、合計 280 words 程度）

> Hi, this is a screencast for the Fumireply Messenger admin tool, applying for `pages_messaging`, `pages_read_engagement`, and `pages_manage_metadata`.
>
> The operator signs in to our admin panel at review.fumireply.ecsuite.work using a Supabase-managed account. Two-factor authentication is disabled for the duration of review per Meta's reviewer guideline.
>
> Once logged in, the operator sees the inbox — a list of Messenger conversations received from the connected Facebook Page. This view uses the `pages_read_engagement` permission to render incoming messages.
>
> Now I'll send a test message from a Messenger user to the connected Page. The webhook delivers it within seconds and the inbox updates. This part uses `pages_manage_metadata` for webhook subscription.
>
> Opening the conversation, you'll notice a draft being generated. The customer's message body is sent to Anthropic's Claude Haiku 4.5 model over HTTPS — this is disclosed in our privacy policy. The AI returns a suggested reply, which is placed into the reply box.
>
> Critically: this is just a suggestion. The operator reads the draft, edits it, and explicitly clicks the Send button. There is no auto-send anywhere in the flow. The Send action calls the Send API using `pages_messaging`.
>
> The customer immediately receives the reply on Messenger.
>
> Finally, all four required public pages — privacy, terms, data deletion, and company info — are served at the same domain over HTTPS. The privacy policy discloses Anthropic as our sub-processor for AI draft generation. Our data deletion endpoint complies with Meta's signed-request callback specification.
>
> Thank you for reviewing.
