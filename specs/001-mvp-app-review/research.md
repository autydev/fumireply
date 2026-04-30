# Phase 0: Research & Decision Log

**Feature**: MVP for Meta App Review Submission
**Branch**: `001-mvp-app-review`
**Date**: 2026-04-20
**Updated**: 2026-04-30 (architecture pivot: Supabase + Anthropic API、AI 下書き生成を MVP コア、Lambda Web Adapter 導入)

design v2 の技術選定に対して、「MVP 審査通過 + AI 下書き生成を主機能として実装」という目的に最適化したブリッジ版の意思決定を記録する。design v2 と同じ決定については本ドキュメントで再審議しない。MVP 固有に降りてきた技術選定のみ扱う。

---

## R-001: Webhook 受信は専用 Lambda に分離（同期で 200 + SQS enqueue）

- **決定**: Webhook 受信を **専用 Lambda（`webhook/`）に分離**し、署名検証 → DB INSERT → SQS enqueue → 200 までを同期で行う。AI 下書き生成は SQS 経由の Worker Lambda に分離する。
- **根拠**:
  - 旧版（同一 Lambda 同居 + AI なし）から仕様が変わった：AI 下書き生成（Claude API、レイテンシ数秒）が MVP コア機能に昇格したため、Webhook の同期処理に AI を含めると Meta の 20 秒 SLA を超える現実的リスクが出る。
  - **受信 Lambda は「すぐ 200 を返す」責務に特化**することでコールドスタート + 処理時間 p95 < 2 秒を確保。
  - 受信ペイロードを `messages` テーブルに先 INSERT してから SQS enqueue することで、Worker が落ちても**メッセージ自体は永続化**されている（SQS の payload には `messageId` のみ載せ、PII を流さない）。
- **検討した代替案**:
  - 旧 R-001 案（同居 Lambda、AI 同期）：AI 呼び出しが 20 秒 SLA を圧迫、却下。
  - API Gateway → SQS 直接統合（Lambda なし）：署名検証ができず不正リクエストが SQS に溜まる、却下。
- **再評価のトリガー**: Worker のリトライが頻発するようなら、SQS の Visibility Timeout・MaxReceiveCount・DLQ 監視のチューニング。

---

## R-002: 認証は Supabase Auth、セッションは JWT Cookie でステートレス

- **決定**: MVP の認証基盤を **Supabase Auth** に切り替える。管理画面ログインは `supabase.auth.signInWithPassword` で JWT を取得 → HttpOnly Cookie に保存する完全ステートレスなセッションで実装する。DB にはユーザーテーブルもセッションテーブルも持たない。Cognito User Pool は MVP では採用しない。
- **根拠**:
  - DB を Supabase Postgres に変更（R-012）したため、Auth も Supabase に統合する方が運用が単純（プロジェクト 1 つで Auth + DB が完結）。
  - Cognito は AWS DVA 試験範囲だが、本 MVP の主目的は「Meta App Review 通過」であり、AWS 統一性より個人運用コストとシンプルさを優先する判断にシフト。
  - JWT ベースのステートレスセッションは Lambda と親和性が高い（毎リクエストでの DB 参照が不要、コールドスタート時の DB 接続確立を待たずに認証判定できる）。
  - Supabase Auth が ES256 で署名した JWT を発行し、Lambda 側は Supabase の公開鍵（JWKS）で検証する。
- **セッション方式の詳細**:
  - **Access Token**（1 時間有効）— `sub`（Supabase Auth UUID）、`email`、`role` を含む JWT。HttpOnly Cookie に保存、各リクエストで署名検証して認証判定に使用。
  - **Refresh Token**（30 日有効、Supabase 側でローテーション）— Access Token 失効時にクライアント SDK が自動更新。HttpOnly Cookie に別途保存。
  - **JWT 検証**: Supabase が公開する JWKS エンドポイント（`https://<project>.supabase.co/auth/v1/keys`）から鍵を取得して JOSE ライブラリで検証。または `@supabase/supabase-js` の `auth.getUser(jwt)` を呼ぶ。Lambda メモリで JWKS をキャッシュ。
- **テナント識別 / ロール管理**: Supabase Auth の `user_metadata` に `tenant_id`（必須、所属テナント UUID）と `role`（任意、UI 表示用）を保存。JWT に自動的に含まれる。**マルチテナント識別は `tenant_id` で行い、ロール分岐は MVP / Phase 2 では実装しない**（1 user = 1 tenant、ログインできれば全機能アクセス可）。Phase 3 以降でマルチオペレーター運用が要求されたら `tenant_users` 中間テーブルで拡張する余地を残す。
- **検討した代替案**:
  - **Cognito User Pool**（旧 R-002 案）：DVA 試験対策には良いが、VPC + RDS 構成を捨てた今、Auth だけ AWS に残す合理性が薄い。Cognito 廃止で SSM パラメータ・Terraform モジュール・初期ユーザー作成スクリプトが大きく削減できる。
  - **better-auth / Lucia（DB セッション）**：Lambda 親和性が低い（毎回 DB 参照）。
  - **Auth0 / Clerk**：MAU 課金。Supabase は同プロジェクト内で完結し追加課金なし。
- **Cookie セキュリティ**:
  - `HttpOnly` + `Secure` + `SameSite=Lax`（CSRF 対策）
  - `Path=/`、`Domain` は省略（同一ドメイン運用）
  - ログアウト時は `supabase.auth.signOut()` を呼んで Refresh Token を Supabase 側でも無効化してから Cookie 削除
- **Phase 2 以降への拡張**:
  - **Meta OAuth フェデレーション**：Supabase Auth の Provider 設定で Facebook を有効化するだけで対応可能。DB 構造の変更不要。
  - **MFA**：Supabase Auth の MFA（TOTP）を ON にするだけ。
  - **AWS 統一性が必要になったら**：Cognito User Pool に移行する Phase 3 案を別途検討（DB が Supabase でも、Auth だけ Cognito にする構成は技術的には可能）。

---

## R-003: 公開ページは TanStack Start 内に同居し、SSG で S3 配信

- **決定**: 公開ページ 4 種は TanStack Start の `routes/(public)/` 配下に実装し、**ビルド時に SSG で静的 HTML を生成して S3 + CloudFront から配信する**。別途 Astro/Next.js 等の静的サイトジェネレータは使わず、単一コードベースで実装する。
- **根拠**:
  - **審査必須ページのコールドスタート回避**：レビュワーが必ず開く `/privacy`, `/terms`, `/data-deletion`, `/`（会社情報）を Lambda 経由にすると、初回アクセス時のコールドスタートで 3 秒以上待たされ「動作不安定」と判定されるリスク。S3 + CloudFront ならレスポンスは数十 ms で確実。
  - **Lambda 課金とアクセス耐性**：公開ページがクローラ等でアクセス増しても Lambda コストが増えない。
  - **障害分離**：Lambda / Supabase / Anthropic が落ちても会社情報・プライバシーポリシーは表示できる。
  - **Lambda コールドスタート以外の理由として、ログインページ（CSR）も同じく初回アクセス時の Lambda 起動を回避できる**（ユーザー体感速度の改善）。
- **検討した代替案**:
  - **代替 A: 全ルート SSR**：構成は最もシンプルだが、公開ページが Lambda 依存となり審査リスク。CloudFront キャッシュで緩和は可能だが初回は遅い。
  - **代替 B: 別途 Astro / Next.js 静的ビルド**：コードベースとデプロイパイプラインが 2 系統になる。単一コードベースで SSG 可能な TanStack Start を使う利点を捨てることになる。
- **注意点**: 審査提出前に各ページのコピーを英語で用意する。プライバシーポリシーには以下を必ず含める：
  - 取得データ項目（Messenger メッセージ本文、送信者 PSID、タイムスタンプ）
  - 保存期間（例：180 日、Meta のデータ保存ポリシーと整合）
  - 削除依頼窓口（メールアドレス）
  - **第三者提供**：AI 下書き生成のために Anthropic（Claude API）にメッセージ本文を送信する旨を必ず明記
  - 連絡先（会社住所、メール、電話）
- **関連**: R-010（ルート単位のレンダリング戦略）、[`infrastructure.md`](./infrastructure.md) の `modules/static-site`

---

## R-004: データ削除コールバック URL の実装方式

- **決定**: `/api/data-deletion` に POST エンドポイントを実装し、Meta の Data Deletion Request Callback 仕様に準拠した JSON レスポンスを返す。削除処理は非同期で実行せず、対象 PSID の `messages` / `conversations` / **`ai_drafts`** を即時 DELETE する。
- **根拠**:
  - Meta は署名付きリクエストで PSID を送ってくる。応答には `url`（削除状況確認 URL）と `confirmation_code` を返す必要がある。
  - MVP の DB 規模では、対象 PSID の関連行を同期で削除しても 1 秒以内で完了する。
  - **AI 下書き機能を MVP に含めたため、`ai_drafts` も削除対象に追加**（プライバシー要件）。
- **検討した代替案**:
  - **代替 A: 非同期化（SQS ワーカー）**：将来スケール時は有利だが、MVP では過剰。
  - **代替 B: 手動削除フォーム URL**：コールバック実装の方が審査印象が良い + 自動化されるため、コールバック採用。
- **テスト**: Meta の App Dashboard から送れるテストリクエストで疎通確認する。

---

## R-005: Page Access Token の長期化と保管

- **決定**: 短期トークン → 長期ユーザートークン → 長期 Page Access Token の 2 段階交換で取得し、**`connected_pages.page_access_token_encrypted` カラムに AES-256-GCM 暗号化して保存する**（R-015 によるマルチテナント化に伴う改訂）。マスター鍵 1 本のみを **SSM Parameter Store の `SecureString`** (`/fumireply/master-encryption-key`) に保管。Lambda 実行時にマスター鍵を SSM から取得しメモリキャッシュ → DB から読んだ暗号化トークンを復号して使用。
- **根拠**:
  - 開発用の短期 Page Access Token（約 60 分有効）では審査中に失効する。長期 Page Access Token は失効しない（アプリ停止・ユーザーパスワード変更等を除く）。
  - **マルチテナント前提（R-015）**：トークンを SSM パラメータとしてテナント別に持つと、新規テナントごとに admin が SSM 操作する必要があり SaaS のセルフサインアップに耐えない。アプリが暗号化して DB に保存する方式ならテナント数に依存せずスケールする。
  - マスター鍵 1 本だけなら SSM 管理対象も 1 つ。Lambda 起動時のキャッシュも単純。
  - Secrets Manager は自動ローテーション機能が売りだが Meta トークンは自動ローテーション非対応、コストも発生（$0.40/secret/月）。MVP では SSM が機能十分。
- **取得手順**（MVP は手動、Phase 2 でセルフサインアップ画面に組み込み）:
  1. Facebook for Developers で短期トークンを生成
  2. Graph API Explorer で `fb_exchange_token` を叩いて長期ユーザートークンに変換
  3. `GET /me/accounts` で該当ページの長期 Page Access Token を取得
  4. seed スクリプトに環境変数として渡す → SSM マスター鍵を取得 → AES-256-GCM 暗号化 → `connected_pages.page_access_token_encrypted` に INSERT（`quickstart.md` §3.1）
- **Graph API バージョン**: `v19.0` に固定する（`contracts/meta-send-api.md` の `graph.facebook.com/v19.0/me/messages`、`quickstart.md` の `fb_exchange_token` 呼び出しと一致）。

---

## R-006: DB マイグレーションと初期データ投入

- **決定**: `drizzle-kit generate` でマイグレーション SQL を生成し、Lambda デプロイ前に `drizzle-kit migrate` を CI / ローカルから実行する。Supabase Postgres に対して直接マイグレーションを適用する。Lambda 起動時のオンボード実行はしない。
- **根拠**:
  - Lambda コールドスタート時にマイグレーションを実行すると並行実行で競合する可能性がある。
  - デプロイパイプライン（GitHub Actions or 手動）から単発実行する方が安全。
  - Supabase の Migration UI もあるが、コードレビュー可能な Drizzle 生成 SQL を正本にする。
- **実務フロー**:
  1. `drizzle-kit generate` でスキーマ変更から SQL 生成
  2. PR レビューで SQL を目視確認
  3. `main` にマージ → GitHub Actions で Supabase に migrate（接続文字列は SSM 経由）→ Lambda デプロイ
  4. MVP ではローカルから `npm run db:migrate` を手動実行

---

## R-007: スクリーンキャスト動画の制作方針

- **決定**: 以下の構成で 2〜3 分の動画を制作する：
  1. 冒頭（10 秒）：アプリ概要・Malbek の業務コンテキスト
  2. セットアップ（30 秒）：テスト FB ページと連携済みであることを画面で示す
  3. 受信デモ（20 秒）：Messenger で顧客役がメッセージ送信 → 管理画面の受信一覧に即時表示
  4. **AI 下書き表示（20 秒）**：スレッドを開く → AI 生成下書きが返信欄にプリセットされていることを示す
  5. 編集・送信デモ（30 秒）：下書きを編集 → 送信 → Messenger 側で到達確認
  6. 権限と Human-in-the-Loop の説明（30 秒）：各シーンに字幕で「Using `pages_messaging` here / Using `pages_read_engagement` here」+「**AI generates a draft only — humans always click Send**」を明示
  7. クロージング（10 秒）：ユーザーへの価値（応答時間の短縮）
- **根拠**:
  - 2〜3 分が審査通過例で最も多い長さ。
  - **AI 下書きを使っていることと、人間が必ず承認・送信していることの両方を見せる必要**がある。「AI bot による自動応答」と判定されないように、送信ボタンを押す瞬間をハイライト。
- **ツール**: QuickTime（macOS 画面収録）+ DaVinci Resolve 無料版（字幕追加）。限定公開 YouTube URL で提出。

---

## R-008: Use Case 説明文の書き方

- **決定**: 以下の英文テンプレート構造で Use Case を書く：

  ```
  Our app enables sellers on Facebook to respond to incoming customer messages
  through an AI-assisted unified inbox. Specifically, we request:

  - pages_messaging: to send reply messages to customers who have initiated
    conversations within the 24-hour window. Replies are composed using an
    AI-generated draft as a starting point, which the human operator reviews,
    edits as needed, and sends with an explicit Send button. Auto-sending is
    not implemented.

  - pages_read_engagement: to read incoming messages from customers on the
    connected Facebook Page, displayed in the admin inbox in real-time and
    used as input to the AI draft generator (Anthropic Claude Haiku).

  - pages_manage_metadata: to subscribe to webhook events for incoming messages
    and optionally manage message labels to categorize customer inquiries.

  The primary benefit to end users (customers) is faster, more accurate responses
  to their product inquiries. The primary benefit to sellers is reducing response
  time from 24+ hours to under 30 minutes per message, with AI-assisted drafting
  reducing the operator's typing time while keeping a human in the loop.

  Future enhancements within this permission scope include:
  (1) AI-based message categorization (price/intent/detail/shipping/stock/other),
  (2) customer profile management with purchase history and VIP tagging,
  (3) product catalog integration for automated price/stock lookups,
  (4) operator notifications via Slack, and
  (5) support for Instagram Direct Messages under the same inbox UX
  (with separate permission requests as required).

  Customer message content is sent to Anthropic (Claude API) solely for the
  purpose of generating reply drafts; this is disclosed in our Privacy Policy.
  Customer data is retained for 180 days and deleted upon request through our
  data deletion callback endpoint, which also removes any AI-generated drafts.
  ```

- **根拠**:
  - **AI 下書き生成を主機能として明記**することで、本アプリの価値主張と権限利用の整合性を確保。
  - **Human-in-the-Loop を明示**：「Auto-sending is not implemented」と書くことで bot 認定を回避。
  - 「将来の拡張機能」を初回申請時点で明示することで、Phase 2 機能追加時に再審査を回避。
  - **Anthropic への送信を Privacy Policy で開示している旨を Use Case にも書く**ことで透明性を担保。

---

## R-009: 審査中の稼働監視

- **決定**: 審査期間中は CloudWatch の以下のアラームを有効化する：
  1. app-lambda Error Rate > 1%（5 分間）
  2. webhook-lambda Error Rate > 0.5%（5 分間、Meta 再送リスクのため厳しめ）
  3. ai-worker DLQ Approximate Message Visible > 0（即時）
  4. keep-alive Lambda Errors >= 1（即時、Supabase Pause 防止のため）
  5. keep-alive Lambda Invocations < 1 in 36 hours（実行されていない異常）
- **根拠**:
  - Meta レビュワーの疎通失敗は「Cannot reproduce」での差し戻し原因になる。即時検知が必要。
  - Supabase の自動 Pause が起きると全機能停止するため keep-alive 失敗は最重要。
  - 通知先は Malbek のメール + Slack（Incoming Webhook）。
- **代替案**: Datadog / New Relic も検討したが、MVP では CloudWatch で十分。
- **運用手順**: `docs/operations/audit-runbook.md` に詳細化（審査提出日にアラーム有効化、結果通知後に無効化）。

---

## R-010: ルート単位のレンダリング戦略（SSG / SSR / CSR の使い分け）

- **決定**: ルート単位で SSG / SSR / CSR を使い分け、**Lambda を通すのは管理画面と API のみ**とする。公開ページは SSG で S3 + CloudFront から配信する。
- **根拠**:
  - 公開ページ（`/`, `/privacy`, `/terms`, `/data-deletion`）は **審査必須かつ静的コンテンツ**。SSR する意味がない上に、Lambda 経由にすると審査中のコールドスタートや Lambda 障害時にページが落ちるリスクがある。S3 + CloudFront なら SLA 99.9%+ で稼働し続ける。
  - `/login` は認証前のためサーバーで事前レンダリングすべき動的データがない。CSR で十分、Lambda 節約になる。
  - `/inbox`, `/threads/$id` は認証チェックと受信データフェッチを同時に行うため SSR が素直（認証 Cookie 検証 → DB クエリ → HTML 返却）。
  - TanStack Start はルート単位で `ssr: false` / prerendering 指定が可能。単一アプリで混在運用できる。
- **ルート別の具体設定**:

  | ルート | 設定 | ビルド時挙動 | ランタイム挙動 |
  |--------|------|-------------|---------------|
  | `/`, `/privacy`, `/terms`, `/data-deletion` | `prerender: true` | ビルド時に HTML 静的生成 → S3 に配置 | CloudFront がエッジキャッシュから返却、Lambda 呼び出しなし |
  | `/login` | `ssr: false` | JS バンドル + 空の HTML shell を S3 に配置 | クライアントで React レンダリング、ログイン serverFn のみ Lambda |
  | `/inbox`, `/threads/$id` | デフォルト（SSR）| ビルド不要 | Lambda（Web Adapter）で SSR、認証確認 + DB クエリ → HTML |
  | `/api/data-deletion` | API route | | SSR Lambda 内 |
  | `/api/webhook` | 別 Lambda | | Webhook 受信 Lambda |

- **CloudFront のルーティング設定**:
  - `/api/*`、`/_serverFn/*`、`/inbox*`、`/threads/*` の動的リクエスト → API Gateway
  - それ以外（`/`, `/privacy`, `/terms`, `/data-deletion`, `/login`, `/_build/*`, `/assets/*`）→ S3 Origin（静的ファイル）
- **検討した代替案**:
  - **代替 A: 全ルート SSR（当初案）**：設定がシンプルだが、公開ページが Lambda 依存となり審査中の稼働リスクが上がる。
  - **代替 B: 全ルート SPA（CSR）**：Lambda 使用量は最小だが、SEO と認証チェックが複雑化、初期表示も遅くなる。
  - **代替 C: 公開ページを別アプリで構築**：デプロイパイプラインが 2 系統になる。
- **効果**:
  - 公開ページが Lambda から独立 → 審査期間中のダウンタイムリスク大幅低減（SC-005 の 99.5% 稼働率を守りやすくなる）
  - 公開ページのレスポンスが p95 < 500ms に
  - Lambda 起動回数が数割減少 → コストとコールドスタート頻度の両方が下がる

---

## R-011: CI/CD をプロジェクト最初期に構築（Walking Skeleton）

- **決定**: 実装の 1 週目で GitHub Actions による CI パイプラインを構築し、「空のアプリ + テスト 1 件」が PR で自動検証される状態を先に作る。機能実装はその後。
- **根拠**:
  - Meta App Review 提出までに独自ドメイン + 24/7 稼働が必須（spec FR-016）。本番稼働に直結するリスクを早期に検出できる仕組みが必要。
  - 後から CI を入れるとテスト資産が肥大化した後で書き直しが発生しやすい。小さいうちに「PR → テスト → マージ → デプロイ」のループを通しておく方が総コスト低。
  - 「Walking Skeleton」手法（Alistair Cockburn）に準拠：**最小機能 + 最小インフラ + 最小 CI が全部繋がっている状態**を先に作り、そこに機能を足していく。
- **初期 CI で達成する状態**:
  1. `app/` ディレクトリに最小の TanStack Start プロジェクト（Hello World ルート 1 つ）
  2. 健康チェック用の統合テスト 1 件（`GET /` が 200 を返す）
  3. `vitest run` が CI で実行される
  4. `terraform fmt -check` と `terraform validate` が CI で実行される
  5. Lambda 用 zip パッケージのビルドが CI で成功する（4 関数：app, webhook, ai-worker, keep-alive）
- **段階的な CI 拡張（スプリントごと）**:

  | スプリント | CI で追加する検証 |
  |-----------|------------------|
  | Sprint 1（W1）| vitest + eslint + tsc + terraform fmt/validate + build zip |
  | Sprint 2（W1〜2）| `terraform plan` を PR にコメント投稿 |
  | Sprint 3（W2）| `playwright` E2E を GitHub Actions で実行（CI 用の簡易 DB + Anthropic / Send API モック）|
  | Sprint 4（W2〜3）| `terraform apply` を手動承認ゲート付きで実行（envs/review）|
  | Sprint 5（W3）| Lambda デプロイパイプライン（S3 upload + update-function-code × 4）|
  | Sprint 6（W3〜4）| 静的サイトビルド + S3 sync + CloudFront invalidation |

- **AWS 認証方式**:
  - GitHub Actions からの AWS アクセスは **OIDC（OpenID Connect）ベースの IAM Role 引き受け**を採用。長期 IAM アクセスキーは発行しない。

---

## R-012: DB は Supabase Postgres（東京リージョン、無料プラン）

- **決定**: MVP の DB は **Supabase Postgres**（東京リージョン）を採用する。AWS RDS / VPC / RDS Proxy / NAT Gateway は使わない。
- **根拠**:
  - **個人運用の月額コスト最小化**：RDS micro + NAT で月 $45〜65 → Supabase 無料で $0。
  - **VPC 不要**：Lambda を VPC 外に出せるため NAT Gateway / VPC Endpoint が不要。Anthropic / Meta API への外向き通信が NAT なしで素直に出る。
  - **Drizzle ORM がそのまま使える**：Supabase は素の Postgres + 拡張なので、`postgres` ドライバ + Drizzle で型安全アクセスを維持。Supabase 専用の型生成は使わない。
  - **Auth との統合**：Supabase Auth と同プロジェクトで完結（R-002）。
  - **東京リージョン**：レイテンシは AWS RDS と同等。
- **接続方式**:
  - **Pooler（pgBouncer 互換、Transaction mode）経由**で接続：`postgres://...pooler.supabase.com:6543/postgres`
  - Lambda は短命接続で接続枯渇しない構成（Pooler 側でコネクション集約）。
  - Drizzle は `postgres` クライアントを `prepare: false` で初期化（Transaction pooler は prepared statement 非対応）。
- **検討した代替案**:
  - **AWS RDS（旧版）**：月 $45〜65、VPC + NAT 必須、運用負荷高い。MVP 個人運用には過剰。
  - **AWS RDS + Lambda VPC 外（パブリック RDS）**：月 $13〜15 だが、RDS パブリック IP のセキュリティ運用が面倒。Supabase に劣る。
  - **Neon**：Supabase と同等の選択肢。Supabase は Auth と統合できる利点がある。
- **無料プランの制約と対策**:
  - 500 MB DB → MVP 規模では十分余裕
  - 50,000 MAU → 個人運用で問題なし
  - **7 日無アクティブで自動 Pause** → **EventBridge + keep-alive Lambda で 1 日 1 回 SELECT 1 を発行（FR-027）**。Lambda 内部で 3 回指数バックオフリトライ + 最終失敗時に SNS Publish + CloudWatch アラーム（Errors >= 1 即時通知 + 36 時間 Invocation なし検知）+ OnFailure Destination の多重防御。1 日 1 回 + 7 日 Pause 閾値で運用者に最低 6 日の対応猶予を確保。
  - Point-in-Time Recovery なし → 日次 `pg_dump` を audit-runbook に組み込む
- **Phase 2 以降への移行**:
  - Pro プラン $25/月で Pause 解除 + 8GB DB + Daily backups
  - 必要なら AWS RDS への移行も Drizzle スキーマ流用で容易（接続文字列の差し替えのみ）

---

## R-013: AI 下書き生成は Anthropic API + Claude Haiku 4.5

- **決定**: AI 下書き生成は **Anthropic API（Claude Haiku 4.5）を直接呼び出す**。AWS Bedrock 経由は採用しない。Worker Lambda が SQS Trigger で起動し、`@anthropic-ai/sdk` で呼び出す。
- **根拠**:
  - **コスト**：Anthropic API と Bedrock の単価は同等。だが Lambda が VPC 外（R-012 / R-014）にあるので Bedrock の VPC Endpoint メリット（NAT 回避）が使えない。
  - **モデル投入の早さ**：Anthropic API の方が新モデルが先行リリースされる。Haiku 4.5（2025-10 リリース）は 2026-04 時点で安定。
  - **Prompt Caching が使える**：システムプロンプト（FAQ・トーン指示）をキャッシュして 90% 割引。MVP の AI コストを月 $1〜3 に抑える鍵。
  - **SDK の素直さ**：`@anthropic-ai/sdk` は内部で fetch を使うので axios 禁止ポリシー（CLAUDE.md）と整合。
- **Claude Haiku 4.5 を選ぶ根拠**:
  - 個人運用の MVP コスト要件（月 $5 以内）を満たす（Sonnet より 1/5 程度）。
  - 「受信メッセージ → 100〜200 文字程度の返信草案」は Haiku で品質十分。
  - レイテンシも速い（p50 ~1s 程度）。
- **プロンプト設計**:
  - System: 「You are a helpful customer support assistant for a TCG retailer. Generate a reply draft based on the customer message. Keep it polite, concise (max 300 chars), and ask clarifying questions if needed. Output the draft only, no preamble.」
  - User: 受信メッセージ本文 + （Phase 2 で）会話履歴 + 商品情報
  - Output: プレーンテキストの返信下書き
- **検討した代替案**:
  - **AWS Bedrock + Claude**：VPC Endpoint で NAT 回避できるメリットがあるが、Lambda が既に VPC 外なので意味がない。SDK が `@aws-sdk/client-bedrock-runtime` で AWS 固有になり、ローカル開発で IAM が要る不便さ。
  - **OpenAI GPT-4o-mini**：価格は Haiku と同等だが、日本語品質は Claude が優勢という社内評価。
  - **Google Gemini Flash**：API キー管理を増やしたくない。
- **コスト試算**:
  - 1 メッセージあたり：入力 ~2KB（500 トークン）+ 出力 ~500 byte（150 トークン）= 約 $0.0008
  - 日 30 件 × 30 日 = 900 件/月 × $0.0008 = **$0.72/月**
  - Prompt Caching でさらに削減可能
- **再評価のトリガー**:
  - 品質が不足する場合は Sonnet 4.6 にアップグレード（コスト数倍）
  - レート制限に当たる場合は Bedrock に切り替えてリージョン分散

---

## R-014: Lambda Web Adapter で TanStack Start を Lambda 化

- **決定**: TanStack Start の SSR Lambda は **AWS Lambda Web Adapter** を Layer として attach し、Node HTTP サーバ（`vinxi start`）をそのまま Lambda 上で起動する。Lambda 専用ハンドラ（`handler.ts` で API Gateway イベントを変換）は書かない。
- **根拠**:
  - **ローカルと本番が同じインタフェース**：`npm run dev` の `vinxi dev` と本番 Lambda が同じ Node HTTP サーバ。Lambda 専用ハンドラを書くと環境差異が生まれる。
  - **TanStack Start の公式デプロイガイドでも推奨**されている方式（Cloudflare Workers / Node Server / AWS Lambda）。
  - **Web Adapter は AWS 公式拡張**で、Layer として attach するだけ。コード変更不要。
- **設定**:
  - Lambda Layer ARN（リージョン依存、Tokyo の例）：`arn:aws:lambda:ap-northeast-1:753240598075:layer:LambdaAdapterLayerX86:<latest>`
  - 環境変数：`AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap`（Web Adapter のラッパースクリプト起動）、`PORT=8080`、`READINESS_CHECK_PATH=/`
  - Lambda タイムアウト：30 秒（SSR + DB クエリ + Send API 呼び出しのワーストケース）
- **コールドスタートへの影響**:
  - Web Adapter のオーバーヘッドは ~100ms 程度。SSR Lambda のコールドスタート全体（~2 秒）の中では誤差。
  - 動的ルート（`/inbox`, `/threads/$id`）でしか発生しないので、公開ページ（S3）は影響なし。
- **検討した代替案**:
  - **Lambda 専用ハンドラ**：API Gateway イベントを直接受け取り Express 風に処理。ローカルとの環境差異が生じる + TanStack Start の SSR 機能を活かしにくい。
  - **Vercel Adapter / Cloudflare Pages**：マルチクラウドになり、AWS 統一性を失う + 学習コスト。

---

## R-015: マルチテナント SaaS を最初から組み込む（RLS 採用に転換）

- **決定**: 将来の SaaS 販売（月額課金）を見据え、**最初からマルチテナントアーキテクチャ**で構築する。`tenants` テーブル + 全データテーブルに `tenant_id` カラム + **RLS（Row Level Security）を全テナント所有テーブルで ON**。MVP 期間中は tenant 1 件（Malbek）を seed で事前作成し、Meta レビュワーは既存テナントにログインする。**セルフサインアップ画面 + Stripe 課金統合は Phase 2**。
- **根拠**:
  - **後付けマイグレーションの罠を避ける**：シングルテナントで本番運用を始めた後にマルチテナント化すると、(a) 全テーブルに `tenant_id NOT NULL` を追加するため既存行の backfill が必要、(b) 全クエリに `WHERE tenant_id = X` を後付けする監査が膨大、(c) RLS を後から ON にすると本番で「クエリが返らなくなる」事故が起きやすい。**最初から組み込む方が桁違いに楽**。
  - **DB 設計コストは小さい**：`tenant_id` カラムを 5 テーブルに足し、RLS ポリシーを 5 行書くだけ。後付けに比べ初期工数の差は数時間。
  - **MVP 提出時の見え方は変わらない**：レビュワーは事前作成済み tenant にログインするだけ。マルチテナントの存在は審査に影響しない。
- **RLS 採用への転換**:
  - 旧方針（単独運用前提）では RLS は overengineering と判断していたが、**マルチテナント化により計算が逆転**：
    - 1 行のクエリ漏れ（`WHERE tenant_id = X` 忘れ）が**他テナントのデータ漏洩**に直結する
    - 課金してプロダクトを売る以上、データ越境バグは事業継続レベルのインシデント
    - RLS は「アプリのバグがあっても DB レイヤで止まる」最後の防衛線
  - **多層防御**：(1) Auth middleware で JWT から `tenant_id` 抽出 → (2) `withTenant` トランザクションヘルパで `SET LOCAL app.tenant_id = '<uuid>'` を流す → (3) RLS ポリシー `tenant_id = current_setting('app.tenant_id')::uuid` が DB 側で強制 → (4) service role / anon role 分離（service role は migration / system 操作専用）
  - **Supabase Pooler との互換性**：Transaction Pooler（port 6543）で `SET LOCAL` が transaction scope で機能する。Drizzle の `db.transaction()` で囲めば自然に統合できる。
- **Page Access Token を SSM から DB 暗号化カラムへ**:
  - 旧方針：`/fumireply/<tenant>/page-access-token` のようにテナントごとに SSM を増やす想定。
  - 新方針：`connected_pages.page_access_token_encrypted bytea` カラムに **AES-256-GCM で暗号化**して保存。マスター鍵 1 本のみ SSM `/fumireply/master-encryption-key` に保管。
  - 根拠：(a) SaaS のセルフサインアップで tenant が増えるたびに admin が SSM 操作する運用は破綻する。(b) アプリが encrypt/decrypt する形式なら tenant 数に依存せずスケールする。(c) マスター鍵 1 本なら IAM・監査・ローテーションの管理対象も 1 つ。
  - 形式：`iv (12B) || auth_tag (16B) || ciphertext`。Lambda メモリでマスター鍵をキャッシュ（TTL 5 分）。
  - ローテーション戦略は Phase 2 で整備（多鍵運用 or KMS 移行）。
- **JWT に tenant claim**:
  - Supabase Auth の `user_metadata.tenant_id` に所属テナントの UUID を保存。JWT に自動的に含まれる。
  - middleware が `verifyAccessToken(token).user_metadata.tenant_id` で抽出 → `tenants.status='active'` を確認 → `withTenant(tenant_id, fn)` で全 DB 操作を実行。
  - 1 user = 1 tenant（Phase 3 以降でマルチオペレーター対応するなら `tenant_users` 中間テーブルで拡張可能）。
- **Webhook ルーティング**:
  - 単一の Meta App、単一の `/api/webhook` エンドポイント。全テナントが共有。
  - 受信 Lambda は **service role** で `connected_pages WHERE page_id = $1` を検索 → `tenant_id` 解決 → 以降の DB INSERT は解決した tenant_id をセットして実行。
- **検討した代替案**:
  - **シングルテナントで開始 → Phase 2 でマルチテナント化**：上述の通り後付けは桁違いにコストが高く、本番事故のリスクも大きい。
  - **RLS なしで middleware の `WHERE tenant_id = X` だけで分離**：1 箇所の書き忘れで全テナント情報が漏洩する。SaaS 商用としては不可。
  - **テナントごとに DB / Supabase プロジェクトを分ける（テナント＝物理隔離）**：強力だが、無料 Supabase プロジェクトの上限・運用コストが膨大。MVP〜中規模 SaaS には不適。
- **コスト影響**:
  - Supabase 無料プランのまま継続可能（DB サイズ・MAU 上限内）。
  - 初期 LOC 増加：~300〜500 行（tenants schema、RLS ポリシー、`withTenant` ヘルパ、`crypto.ts`、middleware の tenant 解決）。
- **未実装事項（Phase 2 で追加）**:
  - セルフサインアップ画面（`/signup` + tenant 作成 + 初期ユーザー作成 + FB ページ連携ウィザード）
  - Stripe Customer 作成 + プラン管理 + Webhook
  - Page Access Token のローテーション運用
  - tenant 削除フロー（解約）
  - マルチオペレーター対応（必要になった段階で）

---

## 未解決事項

なし。すべての設計上の NEEDS CLARIFICATION は解消済み。次フェーズ（Phase 1: Design & Contracts）に進む。
