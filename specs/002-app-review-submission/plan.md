# Implementation Plan: App Review Submission Readiness

**Branch**: `002-app-review-submission` | **Date**: 2026-05-06 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/002-app-review-submission/spec.md`

## Summary

Meta App Review に実際に提出できる状態まで仕上げる。3 ギャップ（Page 接続 UI 不在 / UI 日本語のみ / 申請ドキュメント未完）を解消する。

**アーキテクチャ要点**（詳細は `research.md`）:
- **Connect Facebook Page UI**: 既存 SSR Lambda（TanStack Start）に新規ルート `/onboarding/connect-page` を追加。Lambda 構成・SQS・AI Worker は変更しない。Facebook JS SDK をクライアント側で動的ロードしポップアップで 4 権限同意を取得 → server fn に短期 user token を POST → サーバー側で `fb_exchange_token` → `GET /me/accounts` → ページ選択（クライアント） → server fn が `POST /{page-id}/subscribed_apps` + 既存 `crypto.ts` で AES-256-GCM 暗号化 + `connected_pages` UPSERT。
- **i18n は Paraglide JS**: TanStack Router 公式 example（`examples/react/start-i18n-paraglide`）をベースに導入。コンパイル時生成・ランタイム ~0KB。Cookie ベースの言語永続化（多言語 URL ルーティングは採用しない）。SSR で Cookie を読んでサーバ側で locale を決定し FOUC を回避。
- **DB スキーマ変更なし**: `connected_pages` は既存スキーマを再利用。Language Preference は HttpOnly Cookie `fumireply_locale=en|ja` のみで永続化（DB 不変）。
- **オンボーディングガード**: 既存 `(app)/route.tsx` の `beforeLoad` で `connected_pages` 件数を確認し、0 なら `/onboarding/connect-page` に redirect。`/onboarding/connect-page` 側でも逆ガード（既存接続あれば `/inbox` に redirect）。
- **既存資産再利用**: `app/src/server/services/crypto.ts`（AES-256-GCM）・`app/src/server/db/with-tenant.ts`（テナント分離）・SSM `/fumireply/master-encryption-key` および `/fumireply/review/meta/app-secret`・既存の `connected_pages` テーブル・既存 Webhook 受信 Lambda、すべて変更不要で利用。
- **追加 Lambda なし**: 新規エンドポイントはすべて TanStack Start の `createServerFn` で SSR Lambda 上に実装。Webhook Lambda / AI Worker / keep-alive はノータッチ。
- **撮影前 prep スクリプト**: 本番 Supabase に対して reviewer 一時有効化と `connected_pages` クリアを行う bash ヘルパ。本番影響あるため、実行前 confirmation と SSM パスワード取得手順を含む。

申請ドキュメント（`docs/review-submission/`）は本機能で**最終版に書き換える**。具体的には Page 接続フロー追加 + 英語 UI 前提 + screencast タイムスタンプ参照 + 申請フォーム貼り付けテキストを反映。新規 `submission-walkthrough.md` を作成し提出ボタン押下までを誘導する。

## Technical Context

**Language/Version**: TypeScript 5.x / Node.js 24.x（001 と同一、`nodejs24.x` Lambda ランタイム）
**Package Manager**: npm（lockfile = `package-lock.json`）
**HTTP クライアント方針**: 001 から継続。グローバル `fetch` のみを使用。`axios` 系の新規導入は禁止。Facebook Graph API（`fb_exchange_token` / `/me/accounts` / `/{page-id}/subscribed_apps`）への呼び出しはすべて server fn 内で `fetch` + `AbortSignal.timeout(ms)` で実装する。

**Primary Dependencies**:
- 新規: `@inlang/paraglide-js` + Vite plugin（コンパイル時 i18n、ランタイム ~0KB、TanStack 公式 example 準拠）
- 新規: Facebook JavaScript SDK（`https://connect.facebook.net/en_US/sdk.js` をクライアント側で動的 import、npm パッケージは使わない）
- 既存（変更なし）: `@tanstack/react-start`, `@tanstack/react-router`, `drizzle-orm`, `postgres`, `@supabase/supabase-js`, `@anthropic-ai/sdk`, `@aws-sdk/client-ssm`, `@aws-sdk/client-sqs`, `zod`

**Infrastructure**: 001 の Terraform 構成を継続。**新規 Lambda・新規 SQS・新規 SSM パラメータは追加しない**。本機能は app-lambda（SSR）の中で完結する。Facebook App ID / App Secret は既存の SSM `/fumireply/review/meta/app-secret` を再利用（App ID は環境変数として埋め込み、Secret は server fn 内で SSM 取得）。

**Storage**: 既存 Supabase Postgres を再利用。**スキーマ変更なし**。`connected_pages` テーブルへの INSERT 経路を seed → server fn UPSERT に変更するのみ。Language Preference は HttpOnly Cookie のみで永続化（DB に保存しない）。

**Testing & CI**:
- vitest — Connect Page フローの unit / integration（Graph API モック、暗号化、UPSERT、ガード redirect）
- vitest — i18n 切替の unit / integration（locale Cookie 読み書き、Paraglide メッセージ生成、SSR locale resolution）
- Playwright — オンボーディング → Connect Page → inbox の E2E スモーク（FB Login はテスト用 FB アプリの Test User を使用）
- 既存 CI（GitHub Actions）に Paraglide のコード生成チェック（`paraglide-js compile` の差分なし確認）を追加
- Terraform 変更がないので `terraform plan` ステップは差分ゼロを期待

**Target Platform**: 001 と同一（AWS Lambda + API Gateway + S3/CloudFront + SQS + EventBridge / Supabase）。

**Project Type**: Web application（既存 TanStack Start アプリへの追加機能）

**Performance Goals**:
- Page 接続フロー全体（FB Login ポップアップ → ページ選択 → DB 保存 → /inbox 遷移）p95 < 30 秒、SC-003 の「初回 5 分以内」を確実に達成
- Facebook Graph API 呼び出し（fb_exchange_token / /me/accounts / /{page-id}/subscribed_apps）p95 < 3 秒（タイムアウト 10 秒）
- i18n locale 切替は SSR Cookie のため flash of untranslated content（FOUC）ゼロ
- 既存性能目標（Webhook p95 < 2 秒、SSR p95 < 3 秒、AI 下書き p95 < 60 秒）を維持

**Constraints**:
- **DB スキーマ変更なし**: `connected_pages` は 001 のままで運用。`tenant_id` 一意制約は既存（FR-007 / Edge Cases の二重接続防止のため UPSERT で処理）。
- **マルチテナント安全性**: Connect Page server fn は必ず JWT から `tenant_id` を解決し、`withTenant(tenant_id, fn)` でトランザクションを囲む。Cross-tenant 書き込みを防ぐ。
- **HTTPS 必須**（CloudFront 経由）。Facebook JS SDK の `xfbml=true` は不要だがドメイン認証（Facebook App Settings > Allowed Domains）に `review.fumireply.ecsuite.work` を登録する手順を quickstart に明記。
- **トークンの保存ポリシー**: Facebook user access token（短期・長期どちらも）は **DB に保存しない**。長期 Page Access Token のみを暗号化保存（FR-009）。
- **Anthropic / Send API のフローは変更しない**: AI 下書き生成・送信は 001 のロジックそのまま。Connect 完了後すぐに既存機能が新規 Page に対して動作する必要がある。
- **公開ページは i18n 対象外**（FR-014）: privacy / terms / data-deletion / index は日本語のまま放置。
- **申請ドキュメントは英語**: use-case-description.md, submission-walkthrough.md の本文は英語で記述（Meta レビュワー向け）。reviewer-credentials.md は運用者向け日本語 + 申請フォーム貼り付け用英語ブロックのバイリンガル構成（既存 001 ドラフトの方針を継承）。

**Scale/Scope**:
- 想定アクセス：001 と同一（reviewer + operator 計 3 名）
- 追加コード LOC 目安：~600 行（Connect Page UI 200 + Graph API ラッパー 80 + Paraglide 設定 30 + i18n キー 30 行 × 2 言語 = 60 + ガード redirect 50 + テスト 200）
- 翻訳対象文字列：30〜40 本（screencast 範囲のみ）
- 追加ドキュメント：4 ファイル（use-case-description.md 改訂、screencast-script.md 改訂、reviewer-credentials.md 改訂、submission-walkthrough.md 新規）+ 補助スクリプト 2 本

## Constitution Check

*GATE: Phase 0 研究の前に必ずパス、Phase 1 設計後に再チェック。*

**プロジェクト憲法の状態**: `.specify/memory/constitution.md` は未ラティファイ（テンプレートのまま）。本プランでは 001 と同様の業界標準ゲートを暫定適用する。

| ゲート | 判定 | 根拠 |
|---|---|---|
| **YAGNI** | ✅ PASS | スコープは Meta App Review 提出に必要な最小機能に厳密に限定。Multi-page 接続、Stripe 課金、複数 reviewer、多言語 URL routing、自動翻訳ツール、公開ページ英訳、AI フィードバックの永続化等はすべて除外。 |
| **単一責任** | ✅ PASS | 5 User Story がそれぞれ独立にテスト・デモ可能（spec の Independent Test 節）。Story 1〜2 はコード、Story 3〜5 はドキュメント+運用補助。 |
| **テスト可能性** | ✅ PASS | Connect Page server fn は Graph API モックで unit/integration 可能、i18n 切替は Cookie 読み書きと Paraglide 出力で確認可能、ドキュメントは URL 200 確認とプレースホルダー scan で検証可能、prep スクリプトは reviewer の `banned_until` 値で検証可能。 |
| **シンプル優先** | ✅ PASS | **新規 Lambda を作らない**ため 001 構成（4 関数）を維持。新 DB テーブル不要。i18n は Cookie のみ・URL ルーティングなしで採用最小コスト。Facebook JS SDK は npm 不要で動的 import。 |
| **観測性** | ✅ PASS | Connect Page server fn は構造化ログで「token_exchange / me_accounts / subscribe_apps / encrypt / db_upsert」の各段階を記録。Graph API レスポンスのエラーコード（OAuthException 等）を拾って CloudWatch に出す。 |
| **可逆性** | ✅ PASS | UI 追加は既存ルートに干渉しない。Paraglide 導入失敗時はメッセージ呼び出しを Vite plugin OFF で素通しに戻せる。Connect Page 失敗時は `connected_pages` 行が作られないだけで既存データに影響しない。 |

**複雑性の正当化**: 不要。本機能で複雑な分散構成や非同期パターンは追加しない。

## Project Structure

### Documentation (this feature)

```text
specs/002-app-review-submission/
├── spec.md              # 仕様書
├── plan.md              # 本ファイル
├── research.md          # Phase 0 成果物（技術選定ログ）
├── data-model.md        # Phase 1 成果物（既存 connected_pages 再利用 + Cookie ベース locale）
├── quickstart.md        # Phase 1 成果物（FB Test User 作成・Paraglide ローカル導入手順）
├── contracts/           # Phase 1 成果物（API 契約）
│   ├── facebook-graph.md       # /me/accounts, /{page-id}/subscribed_apps, fb_exchange_token
│   ├── connect-page-fn.md      # createServerFn の入出力契約
│   └── locale-fn.md            # 言語切替 Cookie 設定 server fn
├── checklists/
│   └── requirements.md  # 品質チェックリスト（/speckit.specify で生成済み）
└── tasks.md             # /speckit.tasks で生成（本コマンドでは未生成）
```

### Source Code (repository root)

001 の構成を踏襲し、**追加されるファイル**を中心に示す。既存ファイルへの軽微な追記（i18n 化、ガード追加）は省略表記とする。

```text
app/                              # TanStack Start アプリ（既存）
├── src/
│   ├── routes/
│   │   ├── (app)/
│   │   │   ├── route.tsx                    # MODIFY: connected_pages 件数チェック → /onboarding/connect-page redirect
│   │   │   ├── -components/
│   │   │   │   └── LanguageToggle.tsx       # NEW: EN/JA トグル（Header 内に挿入）
│   │   │   └── onboarding/                  # NEW: オンボーディング配下
│   │   │       └── connect-page/
│   │   │           ├── index.tsx                          # NEW: ルート本体
│   │   │           ├── -components/
│   │   │           │   ├── ConnectFacebookButton.tsx     # NEW: FB JS SDK 呼び出し
│   │   │           │   ├── PageList.tsx                  # NEW: Page 一覧表示・選択
│   │   │           │   └── ConnectErrorPanel.tsx         # NEW: エラー表示・再試行
│   │   │           └── -lib/
│   │   │               ├── exchange-and-list.fn.ts       # NEW: server fn: 短期 token → 長期 user token + /me/accounts
│   │   │               └── connect-page.fn.ts            # NEW: server fn: ページ選択 → subscribe + AES + UPSERT
│   │   ├── (auth)/login/
│   │   │   └── -components/LoginForm.tsx    # MODIFY: i18n 化
│   │   └── ... (inbox, threads, public は既存)
│   ├── server/
│   │   └── services/
│   │       └── facebook.ts                  # NEW: Graph API ラッパー（fb_exchange_token / /me/accounts / subscribed_apps）
│   ├── lib/
│   │   ├── i18n/                            # NEW
│   │   │   ├── locale.ts                    # NEW: Cookie 読み書き、SSR locale 解決
│   │   │   └── set-locale.fn.ts             # NEW: server fn: HttpOnly Cookie 設定
│   │   └── facebook-sdk.ts                  # NEW: FB JS SDK 動的ロード ヘルパ
│   └── styles.css                           # MODIFY: LanguageToggle のスタイル追加
├── messages/                                # NEW: Paraglide メッセージ
│   ├── en.json                              # NEW: 英語訳（screencast 範囲のみ）
│   └── ja.json                              # NEW: 日本語（既存ハードコード文字列の移植）
├── project.inlang/                          # NEW: Paraglide 設定（公式 example 準拠）
│   └── settings.json                        # NEW
├── paraglide/                               # NEW: Paraglide 自動生成（gitignored）
│   └── runtime.ts                           # NEW (compile 時生成)
├── vite.config.ts                           # MODIFY: paraglide-js Vite plugin 追加
├── package.json                             # MODIFY: @inlang/paraglide-js 追加
└── tests/
    ├── integration/
    │   ├── connect-page.test.ts             # NEW: server fn の Graph API モックテスト
    │   └── locale-toggle.test.ts            # NEW: Cookie + Paraglide 出力テスト
    └── e2e/
        └── connect-page-flow.spec.ts        # NEW: Playwright（FB Test User）

scripts/                                     # NEW: 撮影補助
├── prep-screencast.sh                       # NEW: reviewer 有効化 + connected_pages クリア
└── post-screencast.sh                       # NEW: reviewer 無効化 + cleanup

docs/
└── review-submission/
    ├── use-case-description.md              # MODIFY: Connect Page フロー追加 + EN UI 前提 + screencast タイムスタンプ
    ├── screencast-script.md                 # MODIFY: 全シーン EN UI 前提に改訂、Connect Page シーン追加
    ├── reviewer-credentials.md              # MODIFY: Connect Page フロー反映、SSM 取得手順は維持
    └── submission-walkthrough.md            # NEW: 提出ボタン押下までの実務ガイド
```

**Structure Decision**: 既存 TanStack Start モノレポに**新規ルート 1 本（`/onboarding/connect-page`）と Paraglide JS 統合を追加**する最小増分構成。既存 4 Lambda・既存 DB スキーマ・既存 SSM パラメータ・既存 Terraform モジュールはすべて変更しない。Connect Page の実体は SSR Lambda 上の `createServerFn` で完結し、Webhook 受信・AI Worker・keep-alive は非干渉。

i18n は **Cookie ベース**を採用し、URL prefix 方式（`/en/inbox` 等）は使わない。理由：(a) screencast 撮影ターゲットの 5 画面しか対象でなく URL ルートを倍増させるコストが高い、(b) Cookie の方が SSR で locale をシームレスに反映できて FOUC が出にくい、(c) 多言語 URL でないため SEO 影響もなし。

メッセージ管理は **Paraglide JS の inlang プロジェクト形式**を採用し、TanStack Router 公式 example（`examples/react/start-i18n-paraglide`）の Vite plugin 設定をそのままコピー流用する。コンパイル時に `paraglide/runtime.ts` が生成され、`m.button_send()` のような型安全関数経由で文字列を取得する。

撮影補助スクリプトは `app/` 配下ではなく**リポジトリルートの `scripts/`** に配置し、Lambda のデプロイ成果物には含めない（Lambda zip サイズに影響しない）。

## Complexity Tracking

> 不要（Constitution Check で違反なし）。
