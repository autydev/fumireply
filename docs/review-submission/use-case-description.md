# Use Case Description — Fumireply

**Submitted to**: Meta App Review
**App name**: Fumireply
**App ID**: _(申請時に確定する Meta App ID をここに記入)_
**Operator**: Malbek Inc. (株式会社Malbek)
**Reviewer-facing URL**: `https://review.fumireply.ecsuite.work`
**Privacy Policy URL**: `https://review.fumireply.ecsuite.work/privacy`
**Terms URL**: `https://review.fumireply.ecsuite.work/terms`
**Data Deletion URL**: `https://review.fumireply.ecsuite.work/data-deletion`
**Webhook Callback URL**: `https://review.fumireply.ecsuite.work/api/webhook`
**Data Deletion Callback URL**: `https://review.fumireply.ecsuite.work/api/data-deletion`

---

## アクセス許可の使用方法（申請フォーム貼付用・日本語）

> 申請フォーム "App Review → Permissions and Features" の各権限の「リクエストいただいたアクセス許可や機能について…詳細な説明をご記入ください」欄に、**共通プリアンブル + 当該権限の段落**をそのまま貼り付ける。
>
> **言語方針（運用メモ）**: Meta は日本語の説明文を受け付けるため、貼付本文は**日本語**で記載する。`>` で始まる注記は申請担当者向けガイドであり、フォームには貼らない。
>
> **記述方針（運用メモ）**: 本文は実コードの挙動に厳密に一致させる（誇張・未実装機能の記載は差し戻し要因）。pages_read_engagement / pages_show_list は「サーバ側で接続対象 Page の名称・トークンを解決する」用途であり、画面上の可視一覧機能は持たない旨を正直に記載している。
>
> **screencast タイムスタンプ基準（運用メモ）**: 各権限本文の `[screencast m:ss–m:ss]` は `screencast-script.md` のシーン構成と一対一で一致させること。台本を編集したら本ファイルも必ず合わせて更新する。

### 共通プリアンブル（各権限の説明欄の冒頭に貼る）

Fumireply（運営: 株式会社Malbek）は、Facebook ページの運営者（オペレーター）が、顧客から届く Messenger メッセージを Web 管理画面で確認し返信するための業務管理ツールです。中核ワークフローは次のとおりです。

1. 顧客が接続済み Facebook ページに Messenger メッセージを送る。
2. 当社の Webhook がイベントを受信してメッセージを保存し、AI 下書き生成（Anthropic Claude Haiku 4.5、HTTPS 経由）を起動する。
3. AI が生成した返信下書きが、オペレーターの管理受信トレイに「提案」として表示される。
4. オペレーターが下書きを確認し、必要に応じて編集し、**明示的に「送信」ボタンをクリック**して Send API で返信を届ける。**自動送信はコードベースのどこにも実装していない。**

顧客メッセージ本文が下書き生成の目的に限り Anthropic で処理される旨は、プライバシーポリシー（`https://review.fumireply.ecsuite.work/privacy`）で開示しています。顧客データはサービス契約期間中保持し、データ削除エンドポイント経由のリクエストで AI 下書きを含め削除します。

当社 Facebook ページのエンドユーザーは、株式会社Malbek が運営する越境 EC 事業（主にトレーディングカード小売）の顧客です。主な付加価値は、(a) 問い合わせへの応答時間短縮、(b) すべての返信に人間が介在する前提でのオペレーターの入力負担軽減、です。

### Facebook ページ接続フロー（オペレーターがアクセスを付与する手順・screencast に登場）

メッセージ機能が動作する前に、オペレーターはオンボーディング画面で Facebook ページを接続します。レビュワーが実際に確認・再現するフローは以下です。

1. オペレーターが管理画面にログインする。接続済みページが無いアカウントは自動的に `/onboarding/connect-page` にリダイレクトされる。`[screencast 0:20–0:45]`
2. 「Connect Facebook Page」をクリックすると、4 つの申請権限を束ねた Login Configuration（`config_id`）を用いて **Facebook Login for Business** が開き、`pages_show_list` / `pages_manage_metadata` / `pages_read_engagement` / `pages_messaging` を含む単一の同意ダイアログが表示される。`[screencast 0:45–1:25]`
3. 同意すると短期ユーザートークンが当社サーバに送られ、サーバ側で長期ユーザートークンに交換される。**このトークンは暗号化され、最大 10 分の HttpOnly Cookie にのみ一時保持され、ブラウザには一切露出しない。**
4. 続いてオペレーターが接続対象ページの**数値 Page ID** を入力する。サーバは長期ユーザートークンを用いて、その 1 ページの正式名称と長期 Page Access Token を直接取得する（`GET /v19.0/{page-id}?fields=id,name,access_token`）。ユーザーの全ページをブラウザに列挙することはなく、Page Access Token はクライアントに到達しない。`[screencast 1:25–1:45]`
5. サーバは当該ページを `messages` / `messaging_postbacks` Webhook フィールドに購読登録し、Page Access Token を暗号化（AES-256-GCM、フィールド単位）して保存し、セッション Cookie を破棄してオペレーターを受信トレイに着地させる。`[screencast 1:25–1:45]`

---

### `pages_show_list`

**使用方法**:オペレーターが接続画面で数値 Page ID を入力すると、当社サーバはオペレーターの長期ユーザートークンを用いて `GET https://graph.facebook.com/v19.0/{page-id}?fields=id,name,access_token` を呼び出します。`pages_show_list` は、ユーザーが管理するページに対して `access_token` フィールドの返却を認可する権限であり、これにより当社は入力された 1 ページの長期 Page Access Token をサーバ側で取得します。`[screencast 1:25–1:45]`

当社はユーザーの全ページ一覧をブラウザに列挙・表示しません。オペレーターが明示的に入力した 1 ページのみを完全にサーバ側で解決します。これは Page Access Token をクライアントに一切通過させないための意図的なセキュリティ設計で す。取得したトークンは AES-256-GCM でフィールド暗号化して保存し、ブラウザには返しません。

**利用者が得られる付加価値**: オペレーターはページ選択 UI を介さず、Page ID 入力のみで安全に接続を完了できます。トークンはサーバ側で暗号化保管されるため、操作負担と漏洩リスクを最小化できます。

**必要としている理由**: ユーザートークンからページの Page Access Token を取得するには本権限が必要です。これがないと Send API・Webhook 購読に使うページトークンを取得できず、接続フロー全体（受信・返信の前提）が成立しません。当該ページを管理していないユーザーにはトークンが返らず、その場合は接続を拒否します。

---

### `pages_messaging`

**使用方法**: `pages_messaging` を次の 3 つに使用します。(1) 接続済みページ宛の Messenger メッセージを `messages` / `messaging_postbacks` Webhook で受信し受信トレイに表示する `[screencast 1:45–2:00]`。(2) オペレーターが会話を開き、返信欄に事前入力された AI 下書きを確認・編集し、明示的に「送信」ボタンをクリックした時のみ、`POST https://graph.facebook.com/v19.0/me/messages`（`messaging_type: RESPONSE`）を長期 Page Access Token で呼び出し返信を届ける `[screencast 2:00–2:30]`。(3) 受信メッセージの送信者表示名を会話一覧の識別用に取得するため User Profile API（`GET https://graph.facebook.com/v19.0/{PSID}?fields=name`）を呼ぶ。読み取るのは送信者の表示名と PSID のみです。

**自動送信は一切実装していません。** スケジューラ・AI トリガ・バッチ送信は存在せず、すべての送信メッセージは認証済みオペレーターの手動クリックに 1:1 で対応します。24 時間ウィンドウ経過時は送信ボタンを明示的に無効化します。本申請では `pages_messaging_subscriptions` は要求せず、24 時間ウィンドウ内の返信のみ行います。

**利用者が得られる付加価値**: 複数の顧客メッセージを 1 画面で取りこぼしなく管理でき、AI 下書きを人間が必ず確認・編集してから返信するため、応答速度と品質が向上します。

**必要としている理由**: 受信メッセージの取得と返信送信は本アプリの中核機能であり、`pages_messaging` なしでは Messenger の受信・返信が成立しません。送信者名取得も会話の識別に不可欠です。

---

### `pages_read_engagement`

**使用方法**: オペレーターが入力した数値 Page ID をサーバ側で検証・解決する際、Page ノード（`GET https://graph.facebook.com/v19.0/{page-id}?fields=id,name`）を読み取り、接続対象ページの正式名称を取得します。`pages_read_engagement` は当該ページのメタデータ（名称等）を読み取るための権限です。取得したページ名は受信トレイ／スレッド画面で「どのページに接続済みか」を表示する用途にのみ使用します。`[screencast 1:25–1:45]`

投稿・写真・動画・コメント・インサイト等のコンテンツ読み取りは行いません。読み取る Page フィールドは接続対象 1 ページの `id` と `name` のみです（顧客の受信メッセージ自体は Webhook 経由で受信し、`pages_messaging` の項に記載のとおり処理します）。

**利用者が得られる付加価値**: 接続したページの正式名称が画面に表示されることで、オペレーターは正しいページに接続できているかを一目で確認でき、ID の取り違えによる誤接続を防げます。

**必要としている理由**: 入力された Page ID から接続先ページのメタデータ（名称）を解決するために必要です。これがないとオペレーターは数値 ID だけで対象ページを判別できず、接続の正しさを検証できません。

---

### `pages_manage_metadata`

**使用方法**: オペレーターが Page ID を入力して接続を確定すると、当社サーバは当該ページを `messages` および `messaging_postbacks` Webhook フィールドに購読登録します（`POST https://graph.facebook.com/v19.0/{page-id}/subscribed_apps`、`subscribed_fields=messages,messaging_postbacks`）。これにより受信 Messenger イベントが当社 Webhook エンドポイント `https://review.fumireply.ecsuite.work/api/webhook` に配信されます。`[screencast 1:25–1:45]`

購読登録は Facebook ページ接続フロー（上記ステップ 5）の中で、Page Access Token をサーバ側で解決した直後に 1 回だけサーバ側で実行します。ページ名・説明・プロフィール画像等の Page メタデータの変更は行いません。

**利用者が得られる付加価値**: オペレーターは Meta 管理画面で複雑な Webhook 設定を手動で行う必要がなく、Page ID を入力するだけで受信トレイが即座に機能します。

**必要としている理由**: `pages_manage_metadata` がないとアプリ側からページの Webhook 購読を有効化できず、顧客メッセージが一切届きません。接続フロー成立の必須権限です。

---

## 統合機能のテストと再現手順（申請フォーム「統合の機能のテストと再現を実施」欄に貼付・日本語）

> 申請フォームの「統合の機能のテストと再現を実施」欄に、以下のステップ説明をそのまま貼り付ける。認証情報の実値（アプリパスワード／Facebook アカウント／Page ID）は本欄には書かず、フォームの "Reviewer credentials / Test User Credentials" 欄に `reviewer-credentials.md` の手順で別途記入する。`>` で始まる注記はフォームに貼らない。

### 提供する 3 つのアカウント（フォームの認証情報欄に記入）

1. **アプリ管理画面ログイン**: `https://review.fumireply.ecsuite.work/login` の reviewer アカウント（### `pages_manage_metadata`

**使用方法**: オペレーターが Page ID を入力して接続を確定すると、当社サーバは当該ページを `messages` および `messaging_postbacks` Webhook フィールドに購読登録します（`POST https://graph.facebook.com/v19.0/{page-id}/subscribed_apps`、`subscribed_fields=messages,messaging_postbacks`）。これにより受信 Messenger イベントが当社 Webhook エンドポイント `https://review.fumireply.ecsuite.work/api/webhook` に配信されます。`[screencast 1:25–1:45]`

購読登録は Facebook ページ接続フロー（上記ステップ 5）の中で、Page Access Token をサーバ側で解決した直後に 1 回だけサーバ側で実行します。ページ名・説明・プロフィール画像等の Page メタデータの変更は行いません。

**利用者が得られる付加価値**: オペレーターは Meta 管理画面で複雑な Webhook 設定を手動で行う必要がなく、Page ID を入力するだけで受信トレイが即座に機能します。

**必要としている理由**: `pages_manage_metadata` がないとアプリ側からページの Webhook 購読を有効化できず、顧客メッセージが一切届きません。接続フロー成立の必須権限です。
メール＋パスワード）。Fumireply の管理画面にログインするためのものです。2 要素認証は審査期間中は無効、IP 制限もありません。
2. **本物の Facebook アカウント（接続用）**: 接続対象 Test Page を管理する**実在の Facebook アカウント**。当社 Meta アプリの [アプリの役割] → [役割] でこのアカウントに「テスター」役割を付与済みです。**[アプリの役割] の「テストユーザー」機能で作成したテストユーザーではありません**（テストユーザーはボットメッセージを受信できず pages_messaging の検証ができないため、Meta のガイダンスに従い実アカウントを使用します）。接続フローの Facebook Login for Business ダイアログでこのアカウントを使用します。
3. **顧客役の Messenger（実アカウント）**: 接続済みページへメッセージを送り、アプリからの返信を実際に受信するための**実在の Messenger アカウント**（上記 2 と同一アカウントでも、別の実アカウントでも可）。テストユーザーは返信を受信できないため、必ず実アカウントを使用してください。

### エンドツーエンドのテストシナリオ（所要約 4 分）

**Step 1. 管理アプリにサインイン**
`https://review.fumireply.ecsuite.work/login` を開き、アプリ管理画面ログイン（アカウント 1）でサインインします。接続済みページが無いため、自動的に `/onboarding/connect-page` にリダイレクトされます。

**Step 2. Facebook ページを接続（4 権限を付与）**
「Connect Facebook Page」をクリックします。Facebook Login for Business ダイアログが開くので、**本物の Facebook アカウント（アカウント 2、テスター役割）**でログインし、`pages_show_list` / `pages_manage_metadata` / `pages_read_engagement` / `pages_messaging` を含む単一の同意ダイアログで全権限を許可します。当社画面に戻ったら、接続対象ページの**数値 Page ID** を入力し「Connect」を押します。サーバ側でページ名と Page Access Token を解決し、ページを `messages` / `messaging_postbacks` Webhook に購読登録し、`/inbox` にリダイレクトされます。

**Step 3. ページ宛にテスト Messenger メッセージを送信**
スマートフォンの Messenger（または m.me リンク）から、**実在の Messenger アカウント（アカウント 3）**で接続済みページ宛に短いメッセージ（例: "Hi, do you have product X in stock?"）を送ります。約 10 秒以内に受信トレイへ会話が表示されます（自動ポーリング）。

**Step 4. 会話を開く**
左の一覧で新しい会話をクリックして `/threads/<id>` を開きます。ヘッダーに顧客の PSID と「Within 24h window」バッジが表示され、返信欄に一瞬「Draft is being generated...」が出た後、約 30 秒以内に Anthropic Claude Haiku 4.5（プライバシーポリシーで開示）による AI 下書きが返信欄へ自動入力されます。

**Step 5. 編集して送信**
下書きは出発点に過ぎないため自由に編集できます。「Send」ボタンをクリックすると返信が送信されます。**送信は手動クリック操作であり、自動送信はどこにも存在しません。** 数秒以内にアカウント 3 の Messenger に返信が着信します。

**Step 6. 公開ページの確認**
`https://review.fumireply.ecsuite.work/privacy` / `/terms` / `/data-deletion` がいずれも HTTPS で表示されることを確認します。

### レビュワー向け補足

- UI は英語表示です。必要に応じてヘッダーの EN/JA トグルで切り替えられます。
- 接続ステップは Facebook Login for Business を使用し、4 権限を 1 つの同意ダイアログに束ねています。トークンはサーバ側で交換・保存され、Page Access Token はブラウザに一切露出しません。
- 24 時間標準メッセージングウィンドウが経過すると Send ボタンは自動的に無効化されます。`pages_messaging_subscriptions` は要求していません。
- AI 下書き生成は省略可能で、返信欄は常に手入力を受け付け、AI 下書きが無くても Send は動作します。
- データ削除コールバック `POST /api/data-deletion` は Meta の signed request 仕様（HMAC-SHA256）に準拠し、App Settings → Advanced → Data Deletion Request URL の "Send test" で検証できます。

---

## Future enhancements (within the same permission scope)

Within the same permission scope (`pages_messaging`, `pages_read_engagement`, `pages_manage_metadata`), we plan the following enhancements after approval. These are mentioned here so that subsequent rollout does not require a new App Review:

1. **AI-based message categorization** — automatically classifying incoming messages into intent categories (price inquiry, stock check, shipping, product detail, other) to help the operator prioritize, while still requiring a human to send each reply.
2. **Customer profile management** — associating PSIDs with internal customer records, purchase history, and VIP tags, displayed alongside the conversation in the inbox.
3. **Product catalog integration** — letting the AI draft generator look up the operator's product catalog (price, stock, shipping info) so drafts are pre-populated with concrete answers; the operator still reviews and sends.
4. **Operator notifications via Slack** — pushing inbox alerts to a connected Slack workspace so operators get notified outside the admin panel.
5. **Instagram Direct Messages** — supporting the same review-and-send flow for Instagram DMs under the same inbox UX (we will request `instagram_basic` / `instagram_manage_messages` separately as required).

In all of the above, the human-in-the-loop send model remains unchanged. No automated message sending will be added.

---

## Data handling summary

| Data | Source | Purpose | Storage | Retention | Third-party |
|------|--------|---------|---------|-----------|-------------|
| Messenger message body | Webhook | Display + AI draft input | Supabase Postgres (Tokyo, encrypted at rest) | 180 days or until deletion request | Anthropic (HTTPS, draft generation only) |
| PSID (Page-Scoped ID) | Webhook | Conversation identity | Supabase Postgres | Same as above | None |
| Long-lived user token | Connect flow (token exchange) | Resolve the chosen Page's token server-side | Encrypted HttpOnly cookie only (never persisted to DB, never sent to browser) | ≤10 min, cleared on connect | None |
| Page Access Token | Resolved server-side from entered Page ID | Send API authentication + webhook subscription | Supabase Postgres, AES-256-GCM encrypted at field level | Until token rotation | None |
| AI draft text | Anthropic response | Pre-fill operator's reply textarea | Supabase Postgres | Same as message | Stored only on our side |

The data deletion endpoint at `POST https://review.fumireply.ecsuite.work/api/data-deletion` complies with Meta's signed-request specification (HMAC-SHA256). When a deletion request is received, we delete all messages, conversations, and AI drafts associated with the PSID, retaining only a hashed audit log entry as evidence of the deletion.

---

## Reviewer testing notes

- Reviewer credentials and the test Facebook Page handle are provided in `reviewer-credentials.md` (also pasted into the App Review submission form).
- The 24-hour reply window is enforced — please send a fresh inbound message immediately before testing the Send button.
- The reviewer account does not have 2FA enabled and is not IP-restricted, per the Meta reviewer guideline.
- Anthropic API outages are handled gracefully: the reply textarea remains usable with a manually composed reply (no AI draft required to send).
