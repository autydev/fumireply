# Phase 0: Research & Decision Log

**Feature**: MVP for Meta App Review Submission
**Branch**: `001-mvp-app-review`
**Date**: 2026-04-20

design v2 の技術選定に対して、「MVP 審査通過」という狭い目的に最適化したブリッジ版の意思決定を記録する。design v2 と同じ決定については本ドキュメントで再審議しない。MVP 固有に降りてきた技術選定のみ扱う。

---

## R-001: Webhook を専用 Lambda に分離せず、TanStack Start の route に同居させる

- **決定**: MVP では Webhook を専用 Lambda に分離せず、TanStack Start の `routes/api/webhook.ts` に実装し、TanStack Start 本体と同一 Lambda にデプロイする。
- **根拠**:
  - Meta Webhook の 20 秒 SLA が守れるかが唯一の論点。MVP 規模では以下の要因で 20 秒に十分収まる：
    - 審査期間中の受信トラフィックは 1 日 10〜30 件程度（レビュワーの手動テスト）
    - 処理内容は「署名検証 → DB INSERT → 200 返却」のみ（AI 分類は MVP では実行しない）
    - TanStack Start の Lambda コールドスタートは実測 1〜2 秒、ウォーム時は < 500ms
    - DB INSERT は p99 で < 200ms（Drizzle + 接続再利用で）
  - Lambda を 2 本に分離すると Terraform モジュール・IAM・VPC 設定・環境変数管理の複雑さが倍になる。MVP の工数が膨らみ、審査提出までの時間が伸びるリスクの方が大きい。
  - **Phase 2 で分離する際の移行コストは小さい**：`routes/api/webhook.ts` のロジックを別 Lambda ファイルに複製し、API Gateway のルーティングを付け替えるだけ。DB スキーマは共通。
- **ADR-002 との関係**: design v2 の ADR-002 は「Webhook 専用 Lambda に分離」を承認しているが、前提条件として「AI 分類処理が Webhook 経路に入ると 20 秒 SLA を超えるリスクがある」を想定している。MVP では AI 分類が Out of Scope のため、この前提が崩れ、ADR-002 の判断を MVP フェーズに限って保留する。Phase 2 の AI 分類追加時に ADR-002 を再適用する。
- **検討した代替案**:
  - **代替 A: 専用 Webhook Lambda（design v2 準拠）**：将来の拡張性は最高だが、MVP の工数が 1.5 倍に膨らむ。
  - **代替 B: Webhook を SQS に直接投入（API Gateway → SQS 統合）**：Lambda なしで実現可能だが、署名検証のタイミングが取れず、不正リクエストが SQS に溜まる。
- **再評価のトリガー**:
  - 受信トラフィックが 1 日 1000 件を超える
  - Webhook 処理に AI 呼び出し等の重い処理が入る
  - Lambda のコールドスタートが 10 秒を超える事象が発生する

---

## R-002: 認証は Amazon Cognito User Pool、セッションは JWT Cookie でステートレス

- **決定**: MVP から Cognito User Pool を採用し、管理画面ログインは **Cognito `InitiateAuth`（USER_PASSWORD_AUTH）→ JWT を HttpOnly Cookie に保存する完全ステートレスなセッション**で実装する。DB にはユーザーテーブル（`admin_users`）もセッションテーブルも持たない。
- **根拠**:
  - design v2 の目的地が Cognito（ADR 参照、Phase 3 SaaS 化で Meta OAuth プロバイダ連携）。途中で認証基盤を乗り換えるとパスワードハッシュ形式が異なるため全ユーザー再登録が必要になる。最初から Cognito にしておけば移行コスト不要。
  - ユーザーが AWS DVA 試験対策中。Cognito User Pool / App Client / JWKS / JWT 検証は DVA 試験範囲であり、本番アプリで実践することで試験準備と開発が両立する。
  - MVP 規模（3 アカウント）でも Cognito ユーザープール維持のランニングコストは事実上ゼロ（月 50,000 MAU まで無料）。
  - JWT ベースのステートレスセッションは Lambda と親和性が高い（毎リクエストでの DB 参照が不要、コールドスタート時の RDS 接続確立を待たずに認証判定できる）。
  - Cognito の Refresh Token ローテーションにより、ログイン状態を 30 日間維持しつつ ID Token は 1 時間ごとに更新される（セキュリティ上の best practice）。
- **セッション方式の詳細**:
  - **ID Token**（1 時間有効）— `user.sub`, `email`, `cognito:groups` を含む JWT。HttpOnly Cookie に保存、各リクエストで署名検証して認証判定に使用。
  - **Refresh Token**（30 日有効）— ID Token 失効時に `InitiateAuth(REFRESH_TOKEN_AUTH)` で新 ID Token を取得。HttpOnly Cookie に別途保存。
  - **Access Token** — MVP では使わない（他 AWS サービスに Cognito 経由で認可を渡す用途がないため）。
  - **JWT 検証**: `aws-jwt-verify` ライブラリを使用。JWKS は Lambda のメモリキャッシュで保持し、コールドスタート時のみ Cognito の `/.well-known/jwks.json` を取得。
- **ロール管理**: Cognito User Pool Groups を使用（`operators` グループ / `reviewers` グループ）。JWT の `cognito:groups` クレームで判定。
- **検討した代替案**:
  - **代替 A: better-auth / Lucia（DB セッション）**：MVP の工数は最小だが、Phase 3 での Cognito 移行時にパスワード再登録必須。試験対策の観点でもメリット薄。
  - **代替 B: Cognito Hosted UI（OAuth2 Authorization Code Flow）**：ログイン UI をカスタマイズしたい場合に不自由。Meta OAuth フェデレーション時は有利だが MVP では使わない。
  - **代替 C: JWT のみで DB セッションも併用（ハイブリッド）**：失効制御ができるが MVP では過剰。
  - **代替 D: API Gateway Cognito Authorizer**：API Gateway レイヤで JWT 検証を完結させる。シンプルだが、公開ページ（Privacy / Terms 等）と管理画面を同一アプリで出す本構成では、ルートごとの認証ポリシー設定が煩雑になる。アプリ内部ミドルウェアで統一して扱う方が設計が綺麗。
- **Cookie セキュリティ**:
  - `HttpOnly` + `Secure` + `SameSite=Lax`（CSRF 対策）
  - `Path=/`、`Domain=.malbek.co.jp`（サブドメイン間で共有が必要な場合。MVP では不要なので Domain 省略）
  - ログアウト時は Cognito `GlobalSignOut` を呼び、Refresh Token を Cognito 側でも無効化してから Cookie 削除
- **Phase 2 以降への拡張**:
  - **Meta OAuth フェデレーション**（外部セラーが FB アカウントで直接ログイン）：User Pool Identity Provider に Facebook を追加するだけで対応可能。DB 構造の変更不要。
  - **MFA**：User Pool の MFA 設定を ON にするだけ。コード側の変更は minimal（InitiateAuth のレスポンスで `ChallengeName=SMS_MFA` が返るケースを実装）。
  - **他テナントへの拡張**：User Pool を複数作るか、カスタム属性 `custom:tenant_id` で分離。

---

## R-003: 公開ページ（Privacy / Terms / Data Deletion / 会社情報）は TanStack Start 内に同居

- **決定**: 公開ページ 4 種は TanStack Start の `routes/(public)/` 配下に実装し、SSR 配信する。別途静的サイトジェネレータや S3 ホスティングは使わない。
- **根拠**:
  - 独自ドメイン（例: `malbek.co.jp`）配下に 1 アプリで公開するのが最もシンプル。Business Verification 書類のドメインと一致させやすい。
  - CloudFront の `path-based routing` でキャッシュ戦略を分ける必要はない（ページ数が 4 つだけ、更新頻度も低い）。
  - 会社情報ページを会社の公式サイトとして流用できる（Business Verification のドメイン整合性要件を満たす）。
- **検討した代替案**:
  - **代替 A: S3 + CloudFront で静的配信**：ランニングコストは最小だが、デプロイパイプラインが 2 系統になる。
  - **代替 B: 別途 Astro / Next.js 静的ビルド**：SEO やページ速度は最良だが、MVP には過剰。
- **注意点**: 審査提出前に各ページのコピーを英語で用意する。プライバシーポリシーには以下を必ず含める：
  - 取得データ項目（Messenger メッセージ本文、送信者 ID、タイムスタンプ）
  - 保存期間（例：180 日、Meta のデータ保存ポリシーと整合）
  - 削除依頼窓口（メールアドレス）
  - 第三者提供の有無（Claude API は Phase 2 以降のため、MVP では「なし」と記載可能）
  - 連絡先（会社住所、メール、電話）

---

## R-004: データ削除コールバック URL の実装方式

- **決定**: `/api/data-deletion` に POST エンドポイントを実装し、Meta の [Data Deletion Request Callback 仕様](https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback)に準拠した JSON レスポンスを返す。削除処理は非同期で実行せず、**対象 PSID（Page-Scoped ID）のメッセージ群を即時 DELETE** する。
- **根拠**:
  - Meta は署名付きリクエストで PSID を送ってくる。応答には `url`（削除状況確認 URL）と `confirmation_code` を返す必要がある。
  - MVP の DB 規模では、対象 PSID の `messages` / `conversations` 行を同期で削除しても 1 秒以内で完了する。非同期キュー（SQS 等）は不要。
  - 削除状況確認 URL は同一 Lambda の `/api/data-deletion/status/:code` として実装。削除済みなら「Deleted」と返すだけのシンプルな実装。
- **検討した代替案**:
  - **代替 A: 非同期化（SQS ワーカー）**：将来スケール時は有利だが、MVP では過剰。
  - **代替 B: 手動削除フォーム（コールバックではなく削除依頼フォーム URL を登録）**：Meta 側は手動フォーム URL の登録も許容するため、この選択肢もある。ただしコールバック実装の方が審査印象が良い + 自動化されるため、コールバック採用。
- **テスト**: Meta の App Dashboard から送れるテストリクエストで疎通確認する。

---

## R-005: Page Access Token の長期化と保管

- **決定**: 短期トークン → 長期ユーザートークン → 長期 Page Access Token の 2 段階交換で取得し、**AWS SSM Parameter Store の `SecureString`** に保管する。Lambda 実行時に SSM から取得しメモリキャッシュする。
- **根拠**:
  - 開発用の短期 Page Access Token（約 60 分有効）では審査中に失効する。長期 Page Access Token は失効しない（アプリ停止・ユーザーパスワード変更等を除く）。
  - SSM Parameter Store は無料枠内で使え、IAM で Lambda にアクセス許可を付与するだけでよい。Secrets Manager よりも MVP にはシンプル。
  - Lambda のメモリキャッシュで同一インスタンス内の SSM 呼び出しを削減（コールドスタート時のみ SSM 呼び出し）。
- **取得手順**（手動運用）:
  1. Facebook for Developers で短期トークンを生成
  2. Graph API Explorer で `fb_exchange_token` を叩いて長期ユーザートークンに変換
  3. `GET /me/accounts` で該当ページの長期 Page Access Token を取得
  4. SSM に `/fumireply/review/meta/page-access-token` として格納
- **検討した代替案**:
  - **代替 A: 環境変数（Lambda の ENV）に直接埋め込む**：簡単だが、Terraform state 経由で平文漏洩リスク + ローテーション困難。
  - **代替 B: Secrets Manager**：自動ローテーション機能が売りだが Meta トークンは自動ローテーション非対応、コストも発生。
- **ローテーション運用**: 審査通過後、または Meta トークンが失効した場合は手動で SSM を更新。MVP では自動ローテーションは実装しない。

---

## R-006: DB マイグレーションと初期データ投入

- **決定**: `drizzle-kit generate` でマイグレーション SQL を生成し、Lambda デプロイ前に `drizzle-kit migrate` を CI / ローカルから実行する。Lambda 起動時のオンボード実行はしない。
- **根拠**:
  - Lambda コールドスタート時にマイグレーションを実行すると並行実行で競合する可能性がある。
  - デプロイパイプライン（GitHub Actions or 手動）から単発実行する方が安全。
  - 初期データ（レビュワー用テストアカウント、連携ページ情報）は `seed.ts` で別スクリプト化し、手動実行。
- **検討した代替案**:
  - **代替 A: Lambda 起動時に `drizzle.migrate()`**：デプロイパイプライン不要で楽だが、競合リスクあり。
  - **代替 B: RDS の自動マイグレーション（AWS DMS 等）**：MVP には過剰。
- **実務フロー**:
  1. `drizzle-kit generate` でスキーマ変更から SQL 生成
  2. PR レビューで SQL を目視確認
  3. `main` にマージ → GitHub Actions（将来）でステージング DB に migrate → 手動承認 → 本番 migrate → Lambda デプロイ
  4. MVP ではローカルから `npm run db:migrate` を手動実行

---

## R-007: スクリーンキャスト動画の制作方針

- **決定**: 以下の構成で 2〜3 分の動画を制作する：
  1. 冒頭（10 秒）：アプリ概要・Malbek の業務コンテキスト
  2. セットアップ（30 秒）：テスト FB ページと連携済みであることを画面で示す
  3. 受信デモ（30 秒）：Messenger で顧客役がメッセージ送信 → 管理画面の受信一覧に即時表示
  4. 返信デモ（40 秒）：スレッドを開く → 返信欄に入力 → 送信 → Messenger 側で到達確認
  5. 権限説明（30 秒）：各シーンに字幕で「Using `pages_messaging` here / Using `pages_read_engagement` here」
  6. クロージング（10 秒）：ユーザーへの価値（応答時間の短縮）
- **根拠**:
  - 2〜3 分が審査通過例で最も多い長さ。5 分を超えると冗長判定される。
  - 権限名を字幕で明示することで、レビュワーが「どの操作がどの権限の利用証拠か」を一目で判断できる。
  - ナレーションより字幕の方が国際レビュワーに強い。
- **ツール**: QuickTime（macOS 画面収録）+ DaVinci Resolve 無料版（字幕追加）。限定公開 YouTube URL で提出。
- **撮影前チェックリスト**: `docs/review-submission/screencast-script.md` に詳細化。

---

## R-008: Use Case 説明文の書き方

- **決定**: 以下の英文テンプレート構造で Use Case を書く：

  ```
  Our app enables sellers on Facebook and Instagram to respond to incoming
  customer messages through a unified inbox. Specifically, we request:

  - pages_messaging: to send reply messages to customers who have initiated
    conversations within the 24-hour window. This is used when the operator
    clicks the "Send" button in our admin inbox to reply to a customer inquiry
    about product pricing, availability, or shipping status.

  - pages_read_engagement: to read incoming messages from customers on the
    connected Facebook Page, displayed in the admin inbox in real-time.

  - pages_manage_metadata: to subscribe to webhook events for incoming messages
    and optionally manage message labels to categorize customer inquiries.

  The primary benefit to end users (customers) is faster, more accurate responses
  to their product inquiries. The primary benefit to sellers is reducing response
  time from 24+ hours to under 30 minutes per message, with a consolidated workflow
  that handles product pricing, purchase intent, shipping inquiries, and stock
  checks.

  Future enhancements within this permission scope include:
  (1) AI-assisted reply drafting to further reduce response time,
  (2) customer profile management with purchase history and VIP tagging,
  (3) product catalog integration for automated price/stock lookups,
  (4) operator notifications via Slack, and
  (5) support for Instagram Direct Messages under the same inbox UX
  (with separate permission requests as required).

  All data processing occurs within our infrastructure. We do not share customer
  message content with third parties. Customer data is retained for 180 days and
  deleted upon request through our data deletion callback endpoint.
  ```

- **根拠**:
  - 「将来の拡張機能」を初回申請時点で明示することで、Phase 2 機能追加時に再審査を回避できる。
  - 第三者提供なしを明記すると審査通過率が上がる。
  - データ保存期間と削除窓口を明記することで、プライバシーポリシーとの整合性がわかりやすくなる。
- **注意**: 実際の申請時には、Malbek の具体的な業務（TCG 販売、英語圏向け）を冒頭に加える。

---

## R-009: 審査中の稼働監視

- **決定**: 審査期間中は CloudWatch の以下 3 つのアラームを有効化する：
  1. Lambda Error Rate > 1%（5 分間）
  2. RDS CPU > 80%（10 分間）
  3. Webhook エンドポイントの 5xx > 1 件（1 分間）
- **根拠**:
  - Meta レビュワーの疎通失敗は「Cannot reproduce」での差し戻し原因になる。即時検知が必要。
  - 通知先は Malbek のメール + Slack（Incoming Webhook）。
  - SNS Topic 経由で配信することで Phase 2 の Slack 通知基盤と共通化できる。
- **代替案**: Datadog / New Relic も検討したが、MVP では CloudWatch で十分。
- **運用手順**: `docs/operations/audit-runbook.md` に詳細化（審査提出日にアラーム有効化、結果通知後に無効化）。

---

## R-011: CI/CD をプロジェクト最初期に構築（Walking Skeleton）

- **決定**: 実装の 1 週目で GitHub Actions による CI パイプラインを構築し、「空のアプリ + テスト 1 件」が PR で自動検証される状態を先に作る。機能実装はその後。
- **根拠**:
  - Meta App Review 提出までに独自ドメイン + 24/7 稼働が必須（spec FR-016）。本番稼働に直結するリスクを早期に検出できる仕組みが必要。
  - 後から CI を入れるとテスト資産が肥大化した後で書き直しが発生しやすい。小さいうちに「PR → テスト → マージ → デプロイ」のループを通しておく方が総コスト低。
  - 「Walking Skeleton」手法（Alistair Cockburn）に準拠：**最小機能 + 最小インフラ + 最小 CI が全部繋がっている状態**を先に作り、そこに機能を足していく。
  - Terraform の変更も PR で `plan` をコメント投稿 → 人がレビュー → 手動承認で apply、というフローを最初から作ることで、インフラ変更の安全性を確保する。
- **初期 CI で達成する状態**:
  1. `app/` ディレクトリに最小の TanStack Start プロジェクト（Hello World ルート 1 つ）
  2. 健康チェック用の統合テスト 1 件（`GET /` が 200 を返す）
  3. `vitest run` が CI で実行される
  4. `terraform fmt -check` と `terraform validate` が CI で実行される
  5. Lambda 用 zip パッケージのビルドが CI で成功する（デプロイはまだしなくて良い）
- **段階的な CI 拡張（スプリントごと）**:

  | スプリント | CI で追加する検証 |
  |-----------|------------------|
  | Sprint 1（W1）| vitest + eslint + tsc + terraform fmt/validate + build zip |
  | Sprint 2（W1〜2）| `terraform plan` を PR にコメント投稿 |
  | Sprint 3（W2）| `playwright` E2E を GitHub Actions で実行（CI 用の簡易 DB + モック）|
  | Sprint 4（W2〜3）| `terraform apply` を手動承認ゲート付きで実行（envs/review）|
  | Sprint 5（W3）| Lambda デプロイパイプライン（S3 upload + update-function-code）|
  | Sprint 6（W3〜4）| 静的サイトビルド + S3 sync + CloudFront invalidation |

- **GitHub Actions ワークフロー構成**:

  ```
  .github/workflows/
  ├── ci.yml              # PR 時：lint + test + build
  ├── terraform-plan.yml  # PR 時（terraform/ 変更）：plan 出力コメント
  ├── terraform-apply.yml # main マージ後：手動承認後 apply
  ├── deploy-app.yml      # main マージ後：Lambda + S3 デプロイ
  └── e2e.yml             # nightly：本番相当環境で E2E
  ```

- **AWS 認証方式**:
  - GitHub Actions からの AWS アクセスは **OIDC（OpenID Connect）ベースの IAM Role 引き受け**を採用。長期 IAM アクセスキーは発行しない。
  - IAM Role は Terraform で管理（`modules/github-actions-oidc`）、GitHub Environment ごとに異なる Role を割り当て（review → review-deployer Role、prod → prod-deployer Role）。
- **検討した代替案**:
  - **代替 A: 機能完成後に CI 追加**：速く書けるが、本番事故のリスクと手戻りコストが高い。
  - **代替 B: CircleCI / GitLab CI**：GitHub Actions より機能豊富だが、GitHub との統合面で Actions が最短。
  - **代替 C: IAM アクセスキー認証**：OIDC より設定シンプルだが、漏洩リスクあり。2026 年時点で OIDC が AWS 公式推奨。
- **テスト戦略との関係**: CI で回すテストは Plan の Testing 節で定義済み（vitest + playwright）。本 R-011 はその**実行パイプライン**を規定する。
- **禁止事項**:
  - `main` ブランチへの直接コミット禁止（PR 経由のみ）
  - CI を skip する `[skip ci]` コミットは非常時以外禁止
  - `terraform apply` のローカル実行は禁止（Bootstrap を除く）

---

## R-010: ルート単位のレンダリング戦略（SSG / SSR / CSR の使い分け）

- **決定**: ルート単位で SSG / SSR / CSR を使い分け、**Lambda を通すのは管理画面と API のみ**とする。公開ページは SSG で S3 + CloudFront から配信する。
- **根拠**:
  - 公開ページ（`/`, `/privacy`, `/terms`, `/data-deletion`）は **審査必須かつ静的コンテンツ**。SSR する意味がない上に、Lambda 経由にすると審査中のコールドスタートや Lambda 障害時にページが落ちるリスクがある。S3 + CloudFront なら SLA 99.9%+ で稼働し続ける。
  - `/login` は認証前のためサーバーで事前レンダリングすべき動的データがない。CSR で十分、Lambda 節約になる。
  - `/inbox`, `/threads/$id` は認証チェックと受信データフェッチを同時に行うため SSR が素直（認証クッキー検証 → DB クエリ → HTML 返却）。CSR にすると「初期 HTML → 認証チェック API → データフェッチ API → レンダリング」で 3 ラウンドトリップ発生する。
  - TanStack Start はルート単位で `ssr: false` / prerendering 指定が可能。単一アプリで混在運用できる。
- **ルート別の具体設定**:

  | ルート | 設定 | ビルド時挙動 | ランタイム挙動 |
  |--------|------|-------------|---------------|
  | `/`, `/privacy`, `/terms`, `/data-deletion` | `prerender: true` | ビルド時に HTML 静的生成 → S3 に配置 | CloudFront がエッジキャッシュから返却、Lambda 呼び出しなし |
  | `/login` | `ssr: false` | JS バンドル + 空の HTML shell を S3 に配置 | クライアントで React レンダリング、ログイン API のみ Lambda |
  | `/inbox`, `/threads/$id` | デフォルト（SSR）| ビルド不要 | Lambda で SSR、認証確認 + DB クエリ → HTML |
  | `/api/webhook`, `/api/data-deletion` | API route | | Lambda で Server Function 処理 |

- **CloudFront のルーティング設定**:
  - `/api/*` および `/inbox*`, `/threads/*`, `/login` の **動的リクエスト** → API Gateway（Lambda）
  - それ以外（`/`, `/privacy`, `/terms`, `/data-deletion`, `/_build/*`, `/assets/*`）→ S3 Origin（静的ファイル）
  - S3 に存在しない場合のフォールバックは設定しない（404 を素直に返す）
- **検討した代替案**:
  - **代替 A: 全ルート SSR（当初案）**：設定がシンプルだが、公開ページが Lambda 依存となり審査中の稼働リスクが上がる。
  - **代替 B: 全ルート SPA（CSR）**：Lambda 使用量は最小だが、SEO と認証チェックが複雑化、初期表示も遅くなる。
  - **代替 C: 公開ページを別アプリ（Next.js 静的ビルド等）で構築**：デプロイパイプラインが 2 系統になる。1 アプリで混在できる TanStack Start を使うメリットを捨てることになる。
- **効果**:
  - 公開ページが Lambda から独立 → 審査期間中のダウンタイムリスク大幅低減（SC-005 の 99.5% 稼働率を守りやすくなる）
  - 公開ページのレスポンスが p95 < 500ms に（Lambda コールドスタート数秒を回避）
  - Lambda 起動回数が数割減少 → コストとコールドスタート頻度の両方が下がる
- **注意点**:
  - 公開ページ更新時はビルド → S3 アップロード → CloudFront invalidation が必要。プライバシーポリシー等は変更頻度が低いので許容。
  - TanStack Start の prerender 対応は routes の `loader` 内で静的データのみ扱うこと。DB アクセス等は SSR ルートに限定する。

---

## 未解決事項

なし。すべての設計上の NEEDS CLARIFICATION は解消済み。次フェーズ（Phase 1: Design & Contracts）に進む。
