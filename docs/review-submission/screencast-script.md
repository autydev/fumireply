# Screencast Script — Fumireply Meta App Review

**目標尺**: 2:55（最大 4 分 / spec SC-004）
**Format**: 1920×1080, MP4 (H.264), 字幕は焼き込み（**英語**）
**Recording**: macOS QuickTime → DaVinci Resolve で字幕付与
**Upload**: YouTube 限定公開（Unlisted）→ 申請フォームに URL を貼付
**Reviewer-facing URL**: `https://review.fumireply.ecsuite.work`

> **タイムスタンプ同期（運用メモ・日本語）**: 本台本の各 Scene の時間範囲は `use-case-description.md` の `[screencast m:ss–m:ss]` と一対一で一致させること。どちらかを編集したら必ず両方を合わせる。

---

## 撮影前チェック（運用・日本語）

- [ ] 画面録画解像度 1920×1080 / 60fps
- [ ] ブラウザは Chrome、ブックマークバー非表示・拡張機能アイコン非表示、シークレットウィンドウ推奨
- [ ] **UI 言語トグルを EN に切替済み**（ログイン画面右上 / ヘッダーの `EN | JA`）。撮影範囲の全画面が英語表示であること
- [ ] `bash scripts/prep-screencast.sh` を本番に対して実行済み（reviewer 有効化 / `connected_pages` の Malbek 行クリア / health 200）。**ページは事前接続しない — 撮影中に Connect フローで接続する**
- [ ] reviewer 用パスワードをクリップボードに取得済み（prep スクリプトが `pbcopy`）
- [ ] FB Test User（`FB_TEST_USER_EMAIL`）でブラウザの Facebook に未ログイン（Connect 時に毎回同意ダイアログを出すため。`auth_type:'reauthenticate'`）
- [ ] 接続予定 Test Page の**数値 Page ID を手元にメモ**（Scene 4 で入力）
- [ ] テスト顧客役の別 Messenger アカウントを実機スマホで準備（Scene 5 で送信）
- [ ] DevTools / 通知 / メール / SSM パス / Cookie 値が映らない
- [ ] 公開ページ（`/privacy`, `/terms`, `/data-deletion`）が 200 で表示されることを事前確認

> **重要**: 録画中にメッセージを送るスマホは「Meta 側の顧客役」を演じるテストアカウントのみ使用すること。本番ユーザーのメッセージが映り込むと差し戻しの原因になる。Facebook Login のポップアップ言語は Facebook ユーザー側設定に依存し本アプリからは制御できない（許容仕様）。

---

## シーン構成（合計 2:55）

### Scene 1 — Intro（0:00〜0:20 / 20 秒）

**画面**: アプリ紹介スライド（タイトル: "Fumireply — AI-assisted Messenger inbox for Facebook Page operators"）

**字幕（英語・焼き込み）**:
- 上部: `App: Fumireply`
- 下部: `Operated by Malbek Inc. — Cross-border e-commerce support. No auto-send anywhere.`

---

### Scene 2 — Login & forced onboarding redirect（0:20〜0:45 / 25 秒）

**画面**: `https://review.fumireply.ecsuite.work/login`

**操作**:
1. URL バーに `review.fumireply.ecsuite.work/login` を打鍵 → Enter（言語トグルが `EN` であることを一瞬見せる）
2. Email 欄に reviewer メール、Password 欄にパスワード入力（`•` マスクを確認）
3. "Sign in" クリック
4. **接続済みページが無いため自動的に `/onboarding/connect-page` にリダイレクト**されることを見せる

**字幕（英語）**:
- `1. Operator signs in (Supabase Auth, JWT in HttpOnly Cookie)`
- `2. No connected Page yet → forced onboarding redirect`

---

### Scene 3 — Connect Facebook Page: consent to 4 permissions（0:45〜1:25 / 40 秒）

**画面**: `/onboarding/connect-page`

**操作**:
1. "Connect Facebook Page" ボタンをカーソルで指してクリック
2. **Facebook Login for Business のポップアップ**が開く
3. ポップアップ内で、`config_id` の Login Configuration により **4 権限が 1 つの同意ダイアログ**に列挙されることをカーソルで上から下までなぞる:
   - `pages_show_list`
   - `pages_manage_metadata`
   - `pages_read_engagement`
   - `pages_messaging`
4. FB Test User で続行 → 全権限を許可（Allow / 続行）
5. ポップアップが閉じる

**字幕（英語・このシーン中ずっと）**:
- 上部固定: `Permissions granted here: pages_show_list, pages_manage_metadata, pages_read_engagement, pages_messaging`
- 下部: `Single consent dialog via Facebook Login for Business (config_id). The short-lived token is exchanged server-side; tokens never reach the browser.`

> 撮影メモ（日本語）: ポップアップが小さい場合は録画後に拡大トリミング。4 権限の文字列が読めることが審査上もっとも重要。

---

### Scene 4 — Enter Page ID → server resolves Page + subscribes webhook → /inbox（1:25〜1:45 / 20 秒）

**画面**: `/onboarding/connect-page`（同意後、Page ID 入力フォームが表示された状態）

**操作**:
1. 数値 Page ID 入力欄（プレースホルダ例・ヘルプ文が見える）にメモした Page ID を入力
2. "Connect" ボタンをクリック
3. `Connecting…` 表示の後、`/inbox` に着地することを見せる

**字幕（英語）**:
- 上部: `Permission used here: pages_show_list (resolve the single entered Page's name + token, server-side) + pages_manage_metadata (subscribe messages, messaging_postbacks)`
- 下部: `The browser sends only the numeric Page ID. The Page Access Token is fetched and AES-256-GCM-encrypted entirely on the server.`

---

### Scene 5 — Incoming Messenger message via webhook（1:45〜2:00 / 15 秒）

**画面**: PC 画面（左: `/inbox` / 右: テスト顧客役スマホの Messenger アプリ）

**操作**:
1. スマホの Messenger でたった今接続した Test Page を開き、"Hi, do you have this product in stock?" と送信
2. 数秒以内に PC 側 inbox に新規 conversation 行が出現（webhook → DB → 一覧反映）
3. 該当行をクリック → `/threads/$id` へ

**字幕（英語）**:
- 上部固定: `Permission used here: pages_read_engagement`
- 下部: `Incoming Messenger messages are delivered to /api/webhook and listed here in real time.`

---

### Scene 6 — AI draft → human edits → clicks Send（2:00〜2:30 / 30 秒）

**画面**: スレッド詳細 `/threads/$id`

**操作**:
1. ヘッダーに customer 名 / PSID / `Within 24h window` バッジ
2. `Draft is being generated…` バナーが一瞬出る → 数秒で AI suggestion が textarea に自動投入
3. `✨ AI suggestion` ラベルと 👍/👎 を指す
4. textarea に 1 行追記（例: "Let me know your preferred shipping option."）→ `Draft saved` ピル
5. **Send ボタンをカーソルでホバー → クリック（このフレームを 1 秒静止）**
6. 送信後 textarea クリア、`outbound` メッセージが追加、スマホ側にも返信着信（5 秒以内）

**字幕（英語・送信時に強調）**:
- 大きく: `🖱️ Human clicks Send — no auto-send.`
- 補足: `Permission used here: pages_messaging (POST graph.facebook.com/v19.0/me/messages)`

---

### Scene 7 — Closing: public pages（2:30〜2:55 / 25 秒）

**画面**: 公開ページを順に（各 ~8 秒）
1. `/privacy`（"Anthropic, Inc." の段落をハイライト）
2. `/data-deletion`
3. `/terms`

**字幕（英語）**:
- `All public pages served on https://review.fumireply.ecsuite.work over HTTPS.`
- `Data Deletion endpoint: POST https://review.fumireply.ecsuite.work/api/data-deletion (HMAC-SHA256 signed_request).`
- `Anthropic disclosure is included in our Privacy Policy.`

---

## 録画後チェック（運用・日本語）

- [ ] 全字幕が読みやすい位置・サイズか（最低 24pt 推奨）
- [ ] Scene 3 のポップアップで 4 権限の文字列が判読できるか（必要なら拡大トリミング）
- [ ] パスワード / JWT / Cookie 値 / SSM パス / 生 PSID / 実名がフレームに映っていないか（あれば黒塗り）
- [ ] 全画面が英語 UI のままか（JA が一瞬でも出ていないか）
- [ ] 動画ファイルサイズ 100 MB 以下、長さ 4 分以内
- [ ] YouTube アップロード時 "Unlisted（限定公開）"、コメント無効化、年齢制限なし
- [ ] アップロード後、シークレットウィンドウで URL 直叩きで再生可能か確認
- [ ] 撮影後に `bash scripts/post-screencast.sh` を実行（reviewer 再無効化 / 必要なら接続データ cleanup）

---

## ナレーション台本（英語版・読み上げ用、約 300 words）

> Hi, this is a screencast for the Fumireply Messenger admin tool, applying for `pages_show_list`, `pages_manage_metadata`, `pages_read_engagement`, and `pages_messaging`.
>
> The operator signs in to our admin panel at review.fumireply.ecsuite.work using a Supabase-managed account. Two-factor authentication is disabled for the duration of review per Meta's reviewer guideline. Because this account has no connected Page yet, the app redirects to the onboarding screen.
>
> The operator clicks "Connect Facebook Page". This opens Facebook Login for Business with a configuration that bundles all four requested permissions into a single consent dialog: pages_show_list, pages_manage_metadata, pages_read_engagement, and pages_messaging. The operator grants all four.
>
> The short-lived user token is exchanged for a long-lived token entirely on our server and kept only in an encrypted, short-lived HttpOnly cookie. The operator then enters the numeric Page ID of the Page to connect. Using pages_show_list, our server resolves that single Page's name and Page Access Token server-side — the token never reaches the browser. With pages_manage_metadata, the server subscribes the Page to the messages and messaging_postbacks webhook fields. The operator lands on the inbox.
>
> Now I send a test message from a Messenger user to the connected Page. The webhook delivers it within seconds and the inbox updates — this uses pages_read_engagement to render the incoming message.
>
> Opening the conversation, a draft is generated. The customer's message body is sent to Anthropic's Claude Haiku 4.5 over HTTPS — disclosed in our privacy policy. The AI returns a suggested reply placed into the reply box.
>
> Critically, this is just a suggestion. The operator reviews it, edits it, and explicitly clicks Send. There is no auto-send anywhere. The Send action calls the Send API using pages_messaging, and the customer immediately receives the reply.
>
> Finally, all required public pages are served at the same domain over HTTPS, the privacy policy discloses Anthropic as our sub-processor, and our data deletion endpoint complies with Meta's signed-request callback specification.
>
> Thank you for reviewing.
