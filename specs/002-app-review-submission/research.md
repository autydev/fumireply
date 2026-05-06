# Research: App Review Submission Readiness

**Feature**: `002-app-review-submission`
**Date**: 2026-05-06
**Status**: Phase 0 — Outline & Research

技術選定と未確定事項の解消ログ。各エントリは「決定 / 根拠 / 代替案」の 3 セクション構成。

---

## R-001: i18n ライブラリの選定

**決定**: **Paraglide JS**（@inlang/paraglide-js + Vite plugin）を採用する。TanStack Router 公式 example `examples/react/start-i18n-paraglide` の Vite plugin 設定と locale resolution 戦略をそのままコピー流用する。

**根拠**:
- TanStack Router が公式 example と推奨ガイドで Paraglide JS を取り上げており、Vite + TanStack Start の統合パターンが既に確立している（コピペ起点が確実に動く）
- コンパイル時にメッセージ関数が生成されるためランタイム ~0KB、bundle 影響が事実上ゼロ
- 型安全（メッセージキーが TypeScript シンボルとして生成される）。screencast 撮影直前に「翻訳漏れで日本語が表示される」事故をコンパイル段階で検出できる
- 公式 example が CI/CD でテストされているため将来のメンテも追従しやすい

**代替案と却下理由**:
- **react-i18next**：~8KB、TanStack 統合は非公式、辞書ベースで型安全弱い → 却下
- **next-intl / use-intl**：~2KB と軽量だが TanStack Router 公式統合なし、SSR 連携を自前で書く必要あり → 却下
- **LinguiJS**：~3KB と最軽量だが TanStack 公式統合なし、設定が独自 → 却下
- **Tolgee**：CDN/API ベースで AWS Lambda + Supabase 構成と相性が悪い、オーバースペック → 却下

**実装メモ**:
- メッセージファイルは `app/messages/{en,ja}.json` に置く
- Vite plugin が `app/paraglide/runtime.ts` を生成（gitignore 推奨）
- 使い方: `import * as m from '~/paraglide/messages'; m.button_send()`
- locale 切替時は `setLocale('en')` を呼ぶ（Paraglide 公式 API）。Cookie 同期は本機能で薄いラッパーを書く
- SSR で Cookie から locale を読んで `setLocale` する middleware を `app/src/lib/i18n/locale.ts` に実装

---

## R-002: 言語永続化の方式

**決定**: HttpOnly でない通常 Cookie `fumireply_locale=en|ja`（`SameSite=Lax`、`Secure`、`Path=/`、`Max-Age=31536000` = 1 年）。サーバー側でも JS 側でも読み書きする。DB には保存しない。

**根拠**:
- Paraglide の SSR 連携で locale をサーバー側に伝える最もシンプルな手段
- HttpOnly にすると JS から読めず、クライアント側 Paraglide が初期化に困る → HttpOnly **しない**
- DB（Supabase user metadata）に保存する案はテナント横断のクロスデバイス同期に有用だが、screencast 撮影目的では過剰設計
- セキュリティ影響は皆無（ロケール文字列は機密情報ではない）

**代替案と却下理由**:
- **localStorage のみ**：SSR で読めず初回レンダリングが日本語になり次にチカッと英語に切り替わる FOUC が発生 → 却下
- **`app_metadata.locale` を Supabase に保存**：マイグレーション + Supabase Admin API 呼び出しが必要、screencast スコープに比して工数過大 → 却下
- **URL prefix（`/en/inbox`）**：ルートツリー二重化のコスト、現行ルート全部に locale validation 追加が必要 → 却下

---

## R-003: Facebook Login の組込み方式

**決定**: **クライアント側 Facebook JavaScript SDK（FB.login ポップアップ）** を使用。SDK は npm 経由ではなく `<script src="https://connect.facebook.net/en_US/sdk.js">` を動的 import で 1 回ロードする。

**根拠**:
- SDK は Meta 公式で長期サポートされており、ポップアップ UX が screencast の見栄えに最も適合（"Permission dialog" の表示が録画しやすい）
- npm 経由だと SDK のバージョン更新を自前で追う必要があるが、CDN 経由なら Meta が自動更新する
- redirect 型 OAuth 2.0 フロー（手動で `https://www.facebook.com/v19.0/dialog/oauth` を叩く）は実装量が増え、screencast 中に CloudFront ↔ Facebook 間で 2 回画面遷移するため reviewer の理解度を下げる

**代替案と却下理由**:
- **redirect 型 OAuth**：上記の通り画面遷移が増える + state 管理を自前で書く必要あり → 却下
- **Auth.js / Lucia**：認証ライブラリでは過剰（既に Supabase Auth がある）→ 却下
- **react-facebook-login**：保守メンテナンスが停滞 → 却下

**実装メモ**:
- SDK 動的ロード: `app/src/lib/facebook-sdk.ts` に Promise キャッシュ付きの `loadFbSdk()` を実装
- App ID は `import.meta.env.VITE_FB_APP_ID` 経由でビルド時注入（クライアント側に App ID を埋めてよい、Meta は App ID の機密性を主張しない）
- App Secret は **絶対にクライアント側に出さない**（既存 SSM `/fumireply/review/meta/app-secret` を server fn 内でのみ使う）
- スコープ: `pages_show_list,pages_manage_metadata,pages_read_engagement,pages_messaging` を 1 回の同意で取得
- ポップアップブロッカーが効いた場合のフォールバックは「ボタンを押してください」のメッセージ表示のみ（redirect 切替えはやらない、複雑性回避）

---

## R-004: Page Access Token の取得と長期化

**決定**: Facebook JS SDK のポップアップで取得した**短期 user access token を server fn に POST**。サーバ側で：
1. `GET /v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_TOKEN` で長期 user token に交換
2. `GET /v19.0/me/accounts?access_token=LONG_USER_TOKEN` でページ一覧を取得し、レスポンスの `data[].access_token` が**長期 Page Access Token**となる
3. 長期 Page Access Token は理論上は無期限（Facebook が "Never-expiring Page Token" として扱う）

**根拠**:
- Meta 公式ドキュメント `Long-Lived Tokens` の手順に厳密準拠
- 短期 user token を **DB に保存しない** ことでトークン窃取のリスクを最小化
- Page 単位の Token のみ保存することで「user が他の Page を扱う権限を失っても本 Page の Webhook と Send API は継続動作」する

**代替案と却下理由**:
- **クライアント側で長期化**：JS SDK では fb_exchange_token を呼べない（App Secret が必要）→ サーバ側必須
- **System User token**：Business Manager で発行する半永久 Token。本 MVP では運用簡素化のため使わない（Phase 2 検討）

**実装メモ**:
- Graph API バージョンは 001 と同じ `v19.0` 固定
- タイムアウトは `AbortSignal.timeout(10000)`、リトライは指数バックオフ 3 回（既存 `app/src/server/services/messenger.ts` 等のパターンに準拠）
- `app_secret_proof` を併送するかは検討事項：本機能では送らない（複雑性回避、既存 Send API も送っていない）

---

## R-005: Webhook 購読の冪等性

**決定**: ページ選択完了時に `POST /v19.0/{page-id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks` を Page Access Token 付きで呼ぶ。**既に購読済みでも 200 が返る**ため冪等。失敗時は server fn 全体を rollback し、`connected_pages` への INSERT を行わない。

**根拠**:
- Meta の `subscribed_apps` API は idempotent（公式ドキュメント記載）
- Webhook 購読が成功してから DB に保存することで「DB に行はあるが Webhook が届かない」という不整合を防ぐ

**代替案と却下理由**:
- **DB INSERT 先行 → 後で購読**：購読が失敗したら DB から削除する必要があり、トランザクション境界が曖昧 → 却下
- **既存 connected_pages があっても再購読**：upgrade フロー（Phase 2）では必要だが本 MVP では二重接続自体を禁止するので不要

**実装メモ**:
- 購読フィールドは `messages` と `messaging_postbacks` のみ。001 と一致
- 購読確認は Meta App Dashboard の Webhooks → ページ→ subscribed の緑チェックで目視

---

## R-006: 既存テーブル `connected_pages` の流用

**決定**: 001 の Drizzle スキーマをそのまま使用。**マイグレーション不要**。

**理由**:
- 既存スキーマに `tenant_id`, `page_id`, `page_name`, `page_access_token_encrypted` (bytea), `webhook_verify_token_ssm_key`, `created_at`, `updated_at` が揃っている
- 本機能で必要なフィールドはすべて既存にある
- INSERT 経路を seed → server fn UPSERT に変更するだけで済む

**UPSERT のキー**: `tenant_id`（1 テナント = 1 ページの制約による）。`ON CONFLICT (tenant_id) DO UPDATE SET ...` で再接続時にトークンとページ情報を更新。

**Edge case 対応**: spec の Edge Cases「既存のテナントに別の Operator が新規接続を試みる」は **MVP では拒否** する。実装は `(app)/route.tsx` の guard で「既に connected_pages があれば onboarding には行かせない」+ `/onboarding/connect-page` 側の逆 guard で実現。明示的な「再接続したい」ケースは Phase 2 で別 UI を追加する。

---

## R-007: Anti-FOUC（SSR で locale を一致させる）

**決定**: TanStack Start の SSR レンダリング時に Cookie から `fumireply_locale` を読んで Paraglide の `setLocale()` を呼ぶ middleware を、root route の `beforeLoad`（または server middleware）に実装する。

**根拠**:
- TanStack Start は SSR で React レンダリングをサーバ側で実行するため、Paraglide の locale をサーバ側で固定できる
- Cookie はリクエストヘッダから読めるため、HTML を返す時点で正しい locale で文字列が描画される
- クライアント側の hydration 時にも同じ Cookie を読んで `setLocale()` を呼ぶことで一致が保たれる

**代替案と却下理由**:
- **CSR モードに切替**：login が既に CSR なので一見良さそうだが、inbox / threads は SSR が基本 → 却下
- **Locale を URL に埋め込む**：URL prefix の検討で却下済み（R-002）

**実装メモ**:
- `app/src/lib/i18n/locale.ts` に `getLocaleFromRequest()` と `setLocaleCookie()` を実装
- root の `beforeLoad` は使わず、TanStack Start の server middleware（`createMiddleware`）を採用するのが妥当（SSR 全リクエストで実行されるため）。具体実装は contracts/locale-fn.md で定義

---

## R-008: 言語切替トグルの UX

**決定**: ヘッダー右側に **`EN | JA` のテキストトグル**を配置。現在 locale はテキストカラーで強調（active=黒、inactive=灰）。クリックで即時切替（楽観的更新 + サーバ確定）。

**根拠**:
- ボタン 2 個より省スペース
- screencast で「言語が変わる瞬間」が見やすい（テキストカラーの変化＋全画面の文字列が瞬時に切替）
- 楽観的更新により Paraglide の `setLocale` を即座に呼びつつ、Cookie 設定 server fn を非同期で投げる

**代替案と却下理由**:
- **dropdown / select 要素**：MVP は 2 言語のみなのでオーバースペック → 却下
- **国旗アイコン**：政治的議論を呼ぶ場合があるため避ける（公式 example も推奨せず）→ 却下

**実装メモ**:
- コンポーネント: `app/src/routes/(app)/-components/LanguageToggle.tsx` にて Header に挿入
- login 画面のヘッダーは違う構造（`(auth)/login`）のため、login 用に同コンポーネントを別箇所にも挿入（OR 共通 Header コンポーネントに切り出す）
- スタイルは既存の `--color-ink`, `--color-ink-3` 変数を流用

---

## R-009: 翻訳対象文字列の確定

**決定**: screencast 撮影スコープの**画面群のみ**を翻訳。具体対象は以下：

| 画面 | 翻訳対象 |
|---|---|
| `(auth)/login` | LoginForm の入力ラベル、ボタン、エラーメッセージ |
| `(app)/onboarding/connect-page` | 全文（説明、ボタン、Page 一覧、エラー、再試行）|
| `(app)/inbox` | InboxList のフィルタ、空状態、未読バッジ ARIA、ヘッダー |
| `(app)/threads/$id` | スレッドヘッダー、24h 窓バッジ、メッセージ吹き出しの aria-label |
| `(app)/threads/$id` ReplyForm | プレースホルダー、Send ボタン、AI suggestion ラベル、保存済バッジ、エラー、24h 窓バナー |

**翻訳しない範囲（FR-014）**：
- 公開ページ（privacy / terms / data-deletion / index）
- DB 由来の動的文字列（顧客名、ページ名、メッセージ本文）
- Meta が制御する Facebook Login のダイアログ

**メッセージキー命名規則**: `{component}_{element}_{action?}`、例 `login_email_label`, `inbox_filter_unread`, `reply_send_button`, `reply_window_closed_warning`

**実装メモ**:
- 既存ハードコード文字列を grep して洗い出す。完了時に `m.xxx()` 呼び出しに置換
- 文字列カウント目安: 30〜40 本（spec の Scale/Scope と整合）
- `messages/en.json` と `messages/ja.json` の同期は CI で `paraglide-js compile` 差分なし確認で担保

---

## R-010: 撮影前 prep スクリプトの設計

**決定**: bash スクリプト `scripts/prep-screencast.sh` に以下を実装：
1. AWS CLI と Supabase CLI の存在確認
2. SSM から reviewer パスワードを取得（標準出力には**マスク表示**、別途 macOS `pbcopy` でクリップボードにコピー）
3. Supabase Admin API で reviewer の `banned_until = NULL` を実行
4. Supabase Admin API で reviewer の session TTL を最大化（撮影中の auth 切れ防止）— ただし Supabase の制約上不可なら省略可
5. `connected_pages` テーブルから `tenant_id` = Malbek の行を DELETE（撮影で再接続するため）
6. 公開ページ・管理画面・Webhook の 200 確認（`curl -o /dev/null -w "%{http_code}"`）を簡易ヘルスチェック
7. 操作内容を標準出力 + `audit-runbook.md` への append（簡易監査ログ）

**根拠**:
- 手動でやると順番ミスが起きるため自動化が必要（FR-021）
- 本番 DB を触るため、各操作前に `read -p "Continue? (y/n) "` で確認
- 監査ログ append により誰がいつ何をしたかが追跡可能

**代替案と却下理由**:
- **TypeScript で書く**：CI には乗せないので bash で十分。依存ゼロで動かせる方が運用上ラク → bash 採用
- **Terraform で実行**：state 管理に向かない一回性タスク → 却下

**実装メモ**:
- `set -euo pipefail` でエラー時即座に停止
- 環境変数 `AWS_PROFILE` と `SUPABASE_URL` を必須化
- `--dry-run` オプションで本番影響なしで動作確認可能に

---

## R-011: 撮影後 cleanup スクリプトの設計

**決定**: bash スクリプト `scripts/post-screencast.sh` に以下を実装：
1. reviewer の `banned_until` を未来日（例: `2099-12-31T00:00:00Z`）に再設定
2. （オプション、フラグ制御）reviewer のパスワードをローテーション + SSM 更新
3. 撮影で生じた一時 `connected_pages` 行と `conversations` / `messages` の cleanup（オプション、デフォルトは保持）
4. 監査ログ append

**根拠**:
- 提出後のセキュリティ補償統制（reviewer 無効化）の自動化（spec の `audit-runbook.md` 連携）

**代替案と却下理由**: 同 R-010

---

## R-012: テスト戦略

**決定**:
- **unit/integration（vitest）**: Connect Page server fn の各段階を Graph API モック（MSW）で検証。i18n の Cookie 読み書きと Paraglide メッセージ出力を検証。
- **E2E（Playwright）**: ログイン → onboarding → Connect Page（FB Test User）→ Page 一覧から選択 → /inbox 着地、までを 1 シナリオで通す。FB Test User のパスワードは GitHub Actions secrets に保管。
- **手動スモーク**: 本番に対して reviewer 認証情報で実機確認（提出前 1 回 + 撮影前 1 回）。

**根拠**:
- Graph API のモックは MSW で十分（HTTP レスポンスを返すだけ）
- Playwright で FB のリアル UI を触るとログインが flaky なので、テスト用 FB Test User（Meta App 配下で発行可能）を使う。Test User は本物の Page を所有できる

**代替案と却下理由**:
- **Cypress**：001 で Playwright を採用しているため統一 → Playwright 続投
- **本物の reviewer アカウントで E2E**：fragile すぎる + パスワードローテーションと衝突 → 却下

---

## R-013: ドキュメント更新方針

**決定**: 既存 `docs/review-submission/` 配下の 3 ファイルを **完全書き換え**する（部分パッチではなく全文置換）。理由は Connect Page フロー追加と英語 UI 前提という根本的な前提変更があり、断片的修正だと整合性が取れなくなるため。

新規 `submission-walkthrough.md` は Meta App Dashboard の現行 UI を 2026-05 時点の最新スクリーンショット記述で構成する。Meta UI は四半期単位で変わるため「最終確認は提出当日に Meta 公式 docs と差分確認」という運用ガイダンスを文書末尾に明記。

**根拠**:
- 部分パッチだと「古い手順と新手順が混在」し、申請担当者の混乱を招く
- Meta UI 変更への耐性は文書では限界、運用で吸収する

**代替案と却下理由**: なし（完全書き換え一択）

---

## R-014: Sprint 計画と User Story の対応

| Sprint | 期間目安 | 実装する User Story | 主な成果物 |
|---|---|---|---|
| Sprint 1 | 0.5 day | 準備 | Paraglide 公式 example 確認、`docs/review-submission/` 既存 3 ファイル読み込み、FB App 設定確認（Allowed Domains 追加）|
| Sprint 2 | 1 day | US2 i18n + US1 一部 | Paraglide JS 導入、messages/{en,ja}.json 初版、LanguageToggle、root middleware で locale resolution、screencast 範囲の i18n 化 |
| Sprint 3 | 1 day | US1 完結 | Connect Page UI、FB JS SDK ローダー、server fn（exchange-and-list / connect-page）、(app) route の guard、エラー再試行 UI、unit/integration テスト |
| Sprint 4 | 0.5 day | US3 / US4 | use-case-description.md / screencast-script.md / reviewer-credentials.md の改訂、submission-walkthrough.md 作成 |
| Sprint 5 | 0.25 day | US5 | scripts/prep-screencast.sh / post-screencast.sh + 動作確認 |
| Sprint 6 | 0.5 day | 仕上げ | E2E（Playwright + FB Test User）、本番デプロイ、最終手動スモーク、screencast 撮影、申請フォーム入力、submit |

**合計**: 約 3.75 日（1 名フルアロケーション想定）。

---

## R-015: 既知のリスクと対応

| リスク | 影響 | 対応 |
|---|---|---|
| Facebook UI の変更で Login ポップアップが redirect になる | screencast 撮り直し | 提出 1 週間前に撮影、変更検知したら撮り直し |
| Meta App Dashboard の申請フォームが UI 改修される | submission-walkthrough.md の手順が古くなる | 提出当日に Meta 公式 docs と差分確認 |
| Paraglide の Vite plugin が TanStack Start の SSR build を壊す | 開発停止 | 公式 example と完全同一の vite.config.ts から始める。失敗したら use-intl にスイッチ可能（差分はメッセージ呼び出し API のみ）|
| FB Test User の権限スコープが Production と異なる | E2E が通って実機で落ちる | 手動スモークを必須化 |
| Anthropic API 障害で AI 下書きが届かない時の screencast 失敗 | 録画中断 | DLQ 監視 + Anthropic Status Page を撮影直前に確認、空入力で送信できる挙動が 001 で実装済みのためスクリプトに「AI 下書き欠如時のフォールバック撮影分岐」を入れる |
