# Feature Specification: App Review Submission Readiness

**Feature Branch**: `002-app-review-submission`
**Created**: 2026-05-06
**Status**: Draft
**Input**: User description: "Meta App Review 申請を完成させ実際に提出するための機能群（Connect Facebook Page UI、Paraglide JS i18n with EN/JA toggle、申請ドキュメントと screencast 台本の最終化、申請フォーム入力ガイド作成）"

## Overview

`001-mvp-app-review` で構築した Messenger 受信→AI 下書き→人間が編集→送信のフルパスは本番（`https://review.fumireply.ecsuite.work`）で稼働確認済みである。しかし Meta の申請フォームと公式 screencast ガイドラインを精査した結果、**現状のままでは申請が承認されない 3 つのギャップ**が発見された。本機能はそのギャップを解消し、Meta App Review に実際に提出できる状態まで仕上げることを目的とする。

ギャップは以下の通りで、本機能のスコープ全体を駆動する：

1. **Page 接続 UI が存在しない**：現行は `connected_pages` を DB seed で事前投入しており、UI 上に Facebook Login + Page 選択フローが存在しない。Meta は「アクセス許可をユーザーが付与するシーン」を screencast で明示するよう要求しているため、このままでは pages_show_list / pages_manage_metadata / pages_read_engagement / pages_messaging の付与シーンが録画できず、申請承認の見込みが極めて低い。
2. **UI が日本語のみ**：Meta は「screencast 録画前に UI を英語に設定すること」を強く推奨。現状は日本語のみのため、screencast 撮影範囲を英語化する仕組みと EN/JA 切替トグルが必要。
3. **申請ドキュメントと screencast 台本が未完**：`docs/review-submission/` のドラフトは存在するが、Page 接続フロー追加・英語 UI 前提への改訂・各権限ごとの最終文・申請フォーム貼り付けテキストの確定が必要。

承認後（Phase 2）の AI 自動分類・Instagram DM・顧客管理等は本機能の対象外で、`specs/003-...` 以降に温存する。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - オペレーターが Facebook Login で自社のページを接続できる (Priority: P1)

ログイン直後で `connected_pages` が未登録のオペレーター（または Meta レビュワー）は、強制的に Page 接続オンボーディング画面に誘導される。Facebook Login のポップアップで 4 権限（pages_show_list / pages_manage_metadata / pages_read_engagement / pages_messaging）への同意を求められ、同意後は自分が管理する Facebook ページの一覧から接続対象を選択できる。選択するとアプリ側が長期 Page Access Token を取得し、Webhook 購読（messages / messaging_postbacks）を有効化し、暗号化したトークンを保存する。完了後はオペレーターは管理画面（受信トレイ）に進むことができる。

**Why this priority**: Meta が screencast で明示するよう要求している「アクセス許可付与シーン」が成立する唯一のフローであり、これがないと申請対象の 4 権限すべてが承認されないリスクが極めて高い。本機能群全体の中で最も承認確率に直結するため P1。

**Independent Test**: 新規 reviewer 用テストアカウントで `https://review.fumireply.ecsuite.work/login` から始め、Facebook Login → 権限同意 → ページ選択 → 受信トレイ到達までを単独で再現でき、その間に既存の Webhook 受信 / AI 下書き生成 / 返信送信機能（001 で実装済み）が新たに接続されたページに対して機能することを確認できる。

**Acceptance Scenarios**:

1. **Given** Operator がアプリにメール+パスワードでログインしたが、所属テナントに紐づく `connected_pages` レコードが 0 件である、**When** Operator が任意の認証必須ルート（例: `/inbox`）にアクセスする、**Then** システムは `/onboarding/connect-page` に強制リダイレクトする。
2. **Given** Operator がオンボーディング画面にいる、**When** Operator が「Connect Facebook Page」ボタンをクリックする、**Then** Facebook Login のポップアップが開き、pages_show_list / pages_manage_metadata / pages_read_engagement / pages_messaging の 4 権限について同意を求められる。
3. **Given** Operator が 4 権限に同意した、**When** ポップアップが閉じる、**Then** Operator が管理権限を持つ Facebook ページ一覧が画面に表示され、各行にページ名と ID が見える。
4. **Given** ページ一覧が表示されている、**When** Operator が 1 つのページを選択して「Connect」ボタンを押す、**Then** システムは長期 Page Access Token を取得し、Webhook 購読を有効化し、Token を暗号化して保存し、`/inbox` に遷移する。
5. **Given** ページ接続が完了した、**When** スマホ Messenger アプリから接続済みページにメッセージを送る、**Then** 30 秒以内に受信トレイにメッセージが現れ、AI 下書きが生成される（001 既存機能の継続動作）。
6. **Given** 既に `connected_pages` レコードが存在する Operator、**When** `/onboarding/connect-page` に直接アクセスする、**Then** 強制的に `/inbox` に戻され、二重接続は防止される。
7. **Given** Operator が Facebook Login のポップアップで権限同意をキャンセルした、**When** ポップアップが閉じる、**Then** オンボーディング画面に「権限が付与されなかったため接続できませんでした。再試行してください」相当の説明と再試行ボタンが表示される。

---

### User Story 2 - レビュワーは英語 UI で全フローを操作できる (Priority: P1)

Meta レビュワーが screencast を確認しやすいよう、screencast に登場する全画面（ログイン / オンボーディング / 受信トレイ / スレッド詳細 / 返信フォーム）の文字列が英語表示に切り替えられる。ヘッダーに常時表示される言語切替トグル（EN / JA）で言語を選択でき、選択は次回アクセス時にも維持される。録画担当者は撮影前に EN を選び、その状態で全シーンを通しで録画できる。

**Why this priority**: Meta は公式 screencast ガイドラインで「録画前に UI を英語に設定すること」を強く推奨しており、レビュワーの理解度に直結する。日本語のままで提出した場合、追加で全 UI 要素の英訳キャプションを動画に焼き込む必要があり編集コストが跳ね上がる。Meta のレビュー速度・承認確率と動画制作コストの両面で重要なため P1。

**Independent Test**: ヘッダーの言語トグルを EN にした状態で screencast 範囲のすべての画面を巡回し、日本語が残っている要素がないこと、UI レイアウトが崩れないこと、ブラウザを再起動しても EN 設定が保持されていることを単独で確認できる。

**Acceptance Scenarios**:

1. **Given** ユーザーが任意の認証画面または公開ログイン画面を表示している、**When** ヘッダーの言語トグル（EN / JA）が常時可視である、**Then** ユーザーはいつでも言語を切替えられる。
2. **Given** 現在 JA で表示されている、**When** ユーザーが EN を選択する、**Then** screencast 範囲（login / onboarding / inbox / threads / reply form）のすべての可視文字列が英語に切り替わり、画面リロードを待たない。
3. **Given** ユーザーが EN を選択した、**When** ユーザーがブラウザを閉じて再度同じ URL を開く、**Then** UI は EN のまま表示される（言語選択が永続化されている）。
4. **Given** EN モードである、**When** screencast 範囲の画面を全部巡回する、**Then** 日本語の文字列は 1 つも残っていない（プレースホルダー、エラーメッセージ、ボタンラベル、ヘッダー、ツールチップを含む）。
5. **Given** EN または JA モードである、**When** 各画面を表示する、**Then** UI レイアウトは崩れず、テキストオーバーフローやボタン切れが発生しない（最大文字列長で評価）。
6. **Given** 公開ページ（プライバシーポリシー、利用規約、データ削除手順、会社情報）を表示している、**When** ユーザーが言語トグルを操作する、**Then** これらのページはスコープ外のため日本語のまま表示される（仕様通りの挙動）。

---

### User Story 3 - 申請担当者は権限ごとの使用目的文と再現手順をそのまま申請フォームに貼れる (Priority: P1)

申請担当者は `docs/review-submission/` 配下の最終ドキュメント群から、Meta App Dashboard の各権限欄（pages_show_list / pages_manage_metadata / pages_read_engagement / pages_messaging）に貼り付けられる本文テキストを取得できる。本文には Page 接続フロー追加と英語 UI 前提を反映した使用目的が記述されており、screencast 内のタイムスタンプ参照（例: 1:35〜2:05）を含む。reviewer-credentials の手順も Connect Page フローに対応した内容に更新されている。

**Why this priority**: Story 1 と Story 2 で実装される機能を Meta レビュワーが実際に検証するための情報導線。ドキュメントの不整合・古い内容のまま提出すると審査差し戻しの直接原因となり、承認確率に直結するため P1。

**Independent Test**: `docs/review-submission/use-case-description.md` を開き、各権限の本文をコピーして Meta App Dashboard の該当欄にペーストし、文字数制限内で破綻なく入る・本文中の URL がすべて 200 を返す・screencast タイムスタンプが台本と一致する、を単独で確認できる。

**Acceptance Scenarios**:

1. **Given** `docs/review-submission/use-case-description.md` を開いた、**When** pages_messaging / pages_show_list / pages_manage_metadata / pages_read_engagement の 4 セクションを参照する、**Then** 各セクションは「使用目的本文」「screencast タイムスタンプ参照」「再現手順」の 3 ブロックを持ち、Meta フォームの想定文字数制限（おおむね 1000〜2000 文字）に収まっている。
2. **Given** `docs/review-submission/screencast-script.md` を開いた、**When** シーン構成を参照する、**Then** Connect Facebook Page フロー（Story 1）と言語切替（Story 2）が動画内に含まれており、各シーンに開始・終了タイムスタンプが記載されている。タイムスタンプは use-case-description の参照と一致する。
3. **Given** `docs/review-submission/reviewer-credentials.md` を開いた、**When** レビュワー用の手順を読む、**Then** 手順は Connect Facebook Page フローを含む最新のオンボーディング手順を反映しており、Meta フォームに貼れる形でテスト用の認証情報・URL・所要時間が整理されている。
4. **Given** すべての文書が完成した、**When** 文書内のすべての URL（公開ページ・管理画面・Webhook・データ削除）に対してリクエストする、**Then** いずれも HTTPS で 200 を返す。
5. **Given** 文書ドラフト時の暫定値（`<<PAGE NAME>>`、`<<NUMERIC ID>>` 等のプレースホルダー）が存在する、**When** 提出直前のレビューを実施する、**Then** すべてのプレースホルダーが実際の値に置換されている。

---

### User Story 4 - 申請担当者は提出ボタン押下までの実務手順をステップバイステップで実行できる (Priority: P2)

申請担当者は新規ドキュメント `docs/review-submission/submission-walkthrough.md` を読みながら、Meta App Dashboard で「権限欄に何を貼るか／screencast をどこにアップロードするか／reviewer 認証情報をどこに記入するか／提出ボタンを押す前の最終チェック」を順番に実行できる。提出後の運用（reviewer 無効化、CloudWatch アラーム、差し戻し対応の窓口）も別冊参照付きで言及される。

**Why this priority**: Story 3 のテキストが用意されていれば原理的には提出できるが、Meta App Dashboard はナビゲーションが分かりにくく、慣れない担当者は提出順序や複数権限への同一動画アップロードの是非で詰まる。ガイドにより属人性を排除して提出失敗リスクを下げるため P2（必須だが Story 3 がなければ無意味なため優先度は次点）。

**Independent Test**: 申請担当者がガイドだけを見ながら、テスト用の別 Meta App（実提出はしない）で全ステップを通しで完走できる。途中で迷子にならず、誤った順序で項目を埋めることもない。

**Acceptance Scenarios**:

1. **Given** 申請担当者がガイドを開いた、**When** 上から順に手順を読み実行する、**Then** Meta App Dashboard で App Review → Permissions and Features → 各権限への入力 → screencast アップロード → reviewer credentials 入力 → 提出ボタン押下、までの導線がすべて言及されている。
2. **Given** 同一の screencast 動画を 4 権限すべてのアップロード欄に貼ることが Meta の運用で許容される、**When** ガイドを参照する、**Then** その旨と具体的な操作（同じ MP4 ファイルを 4 回アップロード、または同一 URL を 4 か所貼る）が明記されている。
3. **Given** 提出直前のチェックリストが存在する、**When** ガイド末尾を確認する、**Then** Business Verification 承認状態 / 公開ページ 200 / Webhook 緑チェック / reviewer 有効化 / Token 長期化 / Anthropic 開示 / Supabase keep-alive 稼働、を含む最低 10 項目のチェックボックスが揃っている。
4. **Given** 提出後の運用手順が必要、**When** ガイドを参照する、**Then** 既存 `docs/operations/audit-runbook.md` を参照する形で、reviewer 無効化、差し戻し対応、結果通知後 24 時間以内のパスワードローテーション、が言及されている。

---

### User Story 5 - 開発者は撮影前のローカル状態を再現できる (Priority: P3)

screencast の撮影者は、撮影前に「ログアウト状態」「reviewer 有効化」「テストページの 24h 窓内メッセージ既存」「ブラウザ Cookie クリア」等の前提条件を整える必要がある。本機能は撮影前チェックを自動化する補助スクリプトを提供し、一発で前提条件を整える。

**Why this priority**: Story 1〜4 が完了していれば撮影は可能だが、撮影者が手作業で前提条件を整えるとミスが起きやすく、撮影中に「権限ダイアログがスキップされる」「reviewer がブロックされたまま」等の失敗が発生して再撮影になる。コスト削減目的の P3（必須ではないがあれば撮影効率が大幅改善）。

**Independent Test**: 補助スクリプトを実行した後に reviewer の `banned_until` が NULL になり、テストページに直前の 24h 窓内メッセージが存在し、`connected_pages` が空（または接続解除済み）状態になっていることを単独で確認できる。

**Acceptance Scenarios**:

1. **Given** 撮影者が `bash scripts/prep-screencast.sh` 相当のコマンドを実行する、**When** スクリプトが完了する、**Then** reviewer ユーザーの `banned_until` が NULL に更新され、`connected_pages` が当該テナントから削除され（撮影で再接続するため）、操作内容が標準出力に表示される。
2. **Given** スクリプトが reviewer のパスワードを SSM から取得して標準出力に出す必要がある、**When** スクリプトが完了する、**Then** reviewer 用のログイン URL とメールアドレスが出力され、パスワードはマスク表示（または別途の clipboard コピー）される。
3. **Given** 撮影完了後、**When** 撮影者が `bash scripts/post-screencast.sh` 相当のコマンドを実行する、**Then** reviewer の `banned_until` が未来日に再設定され、screencast 撮影で生じた一時的な connected_pages レコードと会話が削除される（または保存される）。

---

### Edge Cases

- **Facebook Login で Operator が複数の Page を管理している**：Page 一覧から複数選択は不可（MVP では 1 テナント = 1 ページ）。1 ページのみ選択可能で、選択 UI でその制約を明示する。
- **Operator が Facebook Login のポップアップでブロッカーに遭遇**：ブラウザがサードパーティ Cookie を強制ブロック / ポップアップブロッカーが発動した場合、フォールバックとして同一画面でのリダイレクト型 OAuth に切り替えるか、エラー画面で「ポップアップを許可してください」と案内する。
- **fb_exchange_token が失敗（短期トークンが既に失効）**：エラーを表示して再試行を促す。Long-lived Token を取得できない場合は接続を完了させない（短期 Token は審査期間中に失効するため）。
- **既存のテナントに別の Operator が新規接続を試みる**：1 テナント = 1 ページの制約により、既存接続を上書きするか拒否するかを選ぶ UI を出す（MVP では拒否し、既存接続を解除する別操作を求める）。
- **言語切替直後に通信が走るシナリオ**：例えば EN モードで `/onboarding/connect-page` の Facebook Login ポップアップを開くとき、Facebook 側のダイアログ言語は Facebook ユーザーの設定に依存し本アプリの言語選択を強制できない（許容仕様、ガイドに記載）。
- **screencast 撮影中の認証セッション切れ**：screencast 撮影中に Supabase Auth の JWT が期限切れになり再ログインを求められると撮影が中断される。撮影前 prep スクリプトは reviewer のセッション TTL を最大化する設定を確認する。
- **言語切替が一部の動的文字列（DB 由来のページ名等）に適用されない**：DB 由来の文字列（接続済みページ名、顧客名等）は元データの言語のまま表示される。これは仕様であり翻訳しない。

## Requirements *(mandatory)*

### Functional Requirements

#### Connect Facebook Page (Story 1)

- **FR-001**: System MUST automatically redirect any authenticated Operator to `/onboarding/connect-page` when their tenant has zero rows in `connected_pages`, on every navigation to authenticated routes (`/inbox`, `/threads/*`, etc.).
- **FR-002**: System MUST present a clearly labeled "Connect Facebook Page" call-to-action on the onboarding screen that initiates the Facebook Login consent flow.
- **FR-003**: System MUST request the four permissions `pages_show_list`, `pages_manage_metadata`, `pages_read_engagement`, and `pages_messaging` together in a single consent dialog, so reviewers can record all four being granted in one step.
- **FR-004**: System MUST retrieve the list of Pages that the authenticated Facebook user manages and display them with at least Page name and Page ID for selection.
- **FR-005**: When the Operator selects a Page and confirms, System MUST: (a) exchange the short-lived user token for a long-lived user token; (b) retrieve the long-lived Page Access Token; (c) subscribe the Page to the `messages` and `messaging_postbacks` Webhook fields; (d) encrypt the Page Access Token at field level; (e) persist the encrypted token, Page ID, and Page name to the `connected_pages` table for the Operator's tenant.
- **FR-006**: System MUST redirect the Operator to `/inbox` immediately after Page connection succeeds.
- **FR-007**: System MUST prevent direct access to `/onboarding/connect-page` for Operators whose tenant already has a `connected_pages` row, redirecting them to `/inbox` instead.
- **FR-008**: System MUST present a clear human-readable error and a retry control if any step in the Page connection flow fails (consent denied, token exchange failure, Webhook subscription failure, encryption failure, or DB write failure).
- **FR-009**: System MUST NOT persist any Facebook user access token; only the long-lived Page Access Token is retained, and only in encrypted form.

#### Internationalization (Story 2)

- **FR-010**: System MUST present a language toggle (EN / JA) in the application header on every authenticated screen and on the login screen.
- **FR-011**: System MUST switch the visible language of all screens within the screencast scope (login, onboarding, inbox, thread detail, reply form, including their banners, error messages, button labels, placeholders, and tooltips) without a full page reload.
- **FR-012**: System MUST persist the user's language selection across browser sessions so that a returning user sees the previously chosen language.
- **FR-013**: System MUST default new users to JA on first visit (current default behavior preserved); the language toggle is the explicit way to switch to EN.
- **FR-014**: System MUST keep public pages (privacy policy, terms of service, data deletion, company info) in Japanese only and excluded from i18n in this iteration.
- **FR-015**: System MUST ensure that the chosen language is reflected on the server-rendered HTML when SSR is involved, so that there is no flash of untranslated content (FOUC).

#### Submission documentation (Story 3, 4)

- **FR-016**: System (in the form of finalized documentation) MUST provide a per-permission Use Case body for each of `pages_show_list`, `pages_manage_metadata`, `pages_read_engagement`, and `pages_messaging` that fits within Meta's typical character limit and includes screencast timestamp references.
- **FR-017**: System MUST provide a finalized screencast script that, in a single recording, demonstrates the granting and use of all four permissions, includes the Connect Facebook Page flow, and uses English UI throughout the recorded screens.
- **FR-018**: System MUST provide a finalized reviewer credentials document that explains how to retrieve credentials securely, the test scenario the reviewer should follow, and the connected test Page handle, all consistent with the Connect Page flow rather than the legacy DB-seeded approach.
- **FR-019**: System MUST provide a submission walkthrough document covering: (a) where to paste each permission's Use Case body in Meta App Dashboard; (b) how to upload or reference the same screencast across all four permissions; (c) where to enter reviewer credentials; (d) the final pre-submit checklist; (e) post-submit operational handoff.
- **FR-020**: All submission documents MUST reference URLs only on the production domain `review.fumireply.ecsuite.work`, with no remaining references to placeholder or legacy domains.

#### Recording prep (Story 5)

- **FR-021**: System MUST provide an automation script that prepares the production environment for recording: enabling the reviewer account (`banned_until = NULL`), clearing the tenant's existing `connected_pages` to allow re-connection on camera, and outputting reviewer login URL and email.
- **FR-022**: System MUST provide an automation script for post-recording cleanup that re-disables the reviewer account, restores `connected_pages` (or leaves the freshly recorded state, configurable), and rotates the reviewer password if requested.

### Key Entities

- **Connected Page**: A Facebook Page connected to a tenant. Holds tenant ID, Page ID, Page display name, encrypted long-lived Page Access Token, Webhook subscription status, and timestamps. Already exists in 001 schema; this feature changes the *creation path* from DB seed to UI.
- **Operator User**: An authenticated user (Supabase Auth) belonging to a tenant. Created in 001; this feature adds the onboarding-required state where the user has no connected page yet.
- **Language Preference**: The user's chosen UI language (`en` | `ja`), persisted across sessions. New entity introduced by this feature.
- **Use Case Document**: Per-permission text bundle (purpose, timestamp references, reproduction steps). New documentation artifact.
- **Submission Walkthrough**: A step-by-step procedural document that guides the submitter from "all artifacts ready" to "submit button clicked". New documentation artifact.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Meta App Review submission form for `pages_show_list`, `pages_manage_metadata`, `pages_read_engagement`, and `pages_messaging` can be submitted without form-validation errors using artifacts produced by this feature.
- **SC-002**: All four requested permissions are approved at Advanced Access level within the first or second review cycle (target: ≤ 2 round-trips with Meta).
- **SC-003**: A first-time Operator (or reviewer) completes Facebook Page connection from logged-in state to landing on `/inbox` in under 5 minutes, including reading on-screen instructions.
- **SC-004**: A single screencast (3 to 4 minutes) clearly demonstrates the granting and use of all four permissions, starting from a logged-out state and ending with a reply delivered to the customer's Messenger.
- **SC-005**: When a user toggles the UI language, 100% of strings within the screencast-scope screens switch to the chosen language with zero remaining strings in the other language and no visible layout breakage.
- **SC-006**: Submission documentation review by an internal reviewer finds zero remaining placeholders, zero broken URLs, and zero references to a domain other than `review.fumireply.ecsuite.work`.
- **SC-007**: A submitter unfamiliar with Meta App Dashboard can complete the submission flow in under 30 minutes using only the submission walkthrough document.
- **SC-008**: 0 incidents of the reviewer account being unintentionally locked out during the review window after using the recording prep automation.

## Assumptions

- 001-mvp-app-review の機能（Webhook 受信 / AI 下書き生成 / 返信送信 / RLS / 暗号化ヘルパ / Supabase keep-alive）は本機能着手時点で稼働しており、本機能はその上に重ねるかたちで開発する。
- Facebook App は既に Meta for Developers 上で作成済みで、Business Verification は申請中または承認済みであり、本機能では新規 App 作成は行わない。
- 1 テナント = 1 接続ページの制約を維持する（複数ページ接続は元 spec.md の Phase 2 想定）。
- 言語切替の対象は screencast 撮影に登場する画面のみ（公開ページ群は審査用 MVP では日本語のままでも Meta 審査に支障なし、と判断する）。
- 言語切替の永続化は同一ブラウザ内のみ（クロスデバイス同期は不要）。
- screencast 録画作業（QuickTime / iMovie / CapCut 等の操作と YouTube アップロード）は本機能の自動化対象外で、人間が実施する。
- 撮影前の reviewer 一時有効化、撮影直後の `connected_pages` 暫定状態は、本機能の運用範囲内で許容される（reviewer が直接画面録画する場合と整合）。
- 提出フォームでアップロードできる動画ファイルの上限・URL 参照可否は Meta の現行仕様に従う（提出時に再確認する）。
- レビュワーは Meta 側の指針に従って 2FA を無効化・IP 制限なしのテストアカウントを使う（001 で運用ルール確立済み）。
- 既存の crypto.ts / SSM の `/fumireply/master-encryption-key` / connected_pages テーブル構造は本機能でも流用し、スキーマ変更は最小限に留める。

## Dependencies

- 001-mvp-app-review の本番デプロイが安定稼働していること（前提）。
- Meta for Developers 上の Facebook App、Business Verification、ドメイン認証、HTTPS 配信、独自ドメイン `review.fumireply.ecsuite.work` の有効化が継続していること。
- Supabase プロジェクト・SSM Parameter Store の値（master 暗号鍵、Meta App Secret、Webhook Verify Token 等）が設定済みであること。
- レビュワー用テストアカウント（`reviewer@malbek.co.jp`）と Malbek tenant が DB に既存であること（001 セットアップ済み）。
