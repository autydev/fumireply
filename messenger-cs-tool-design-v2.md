# Messenger CS 半自動応答ツール — 設計書 v2

> **プロジェクト名**: Messenger Customer Support Auto-Responder
> **作成日**: 2026-04-18
> **作成者**: 松原勇太（株式会社Malbek）
> **ステータス**: 設計確定・開発着手前

---

## 1. プロジェクト概要

| 項目 | 内容 |
|------|------|
| 月間メッセージ数 | 300件以上 |
| 対応チャネル | Facebook Messenger + Instagram DM |
| 対応言語 | 英語 |
| 削減目標 | メッセージ対応時間 月10h → 3h |
| 操作デバイス | スマホとPC半々（レスポンシブ必須） |
| マルチテナント | MVPからテナント分離を意識した設計 |
| デザインツール | Claude Design |

---

## 2. 確定した要件

### 2.1 メッセージ分類カテゴリ（頻度順）

1. 価格確認・見積もり
2. 購入意思表示（「I want this」系）
3. 商品詳細（状態・言語版等）
4. 発送状況・追跡番号
5. 在庫確認
6. その他

### 2.2 承認フロー

- **v1**: 管理画面で確認・編集・承認（メイン） + Slack着信通知
- **v2**: Slackから直接承認（Block Kit + Bolt）

### 2.3 MVP機能優先順位

1. 顧客管理（VIPタグ・購入履歴）
2. 価格/在庫の自動応答ドラフト生成
3. PayPal/Wise請求リンク自動生成
4. 追跡番号自動送信

### 2.4 在庫・価格データの現状

- 現状: スプレッドシート + LINE仕入れ情報の混在
- 将来: Shopifyへ移行予定

### 2.5 決済フロー

- 毎回手動でPayPal or Wise請求書を発行（v1はそのまま、v2で自動化）

---

## 3. アーキテクチャ

### 3.1 3つのLambdaの役割分担

TanStack Startがフロント + アプリAPIを一手に担い、分離するのはWebhook受信と非同期処理のみ。

#### Webhook Lambda（軽量・専用）

- **役割**: Meta Webhookの受信に特化
- **処理**: 署名検証 → SQSに投入 → 即200返却
- **目標**: コールドスタート100ms以下
- **分離理由**: MetaはWebhookレスポンスが20秒以内に返らないとリトライし、失敗が続くとWebhook自体を無効化する。TanStack Start本体はバンドルサイズが大きくコールドスタートが遅いため、軽量専用Lambdaで確実に即応答する必要がある。

#### 分類・ドラフト Lambda（非同期・SQSトリガー）

- **役割**: メッセージの分類と返信ドラフト生成
- **処理**: SQSからメッセージ取得 → Claude APIで分類 + ドラフト生成 → RDSに保存 → Slack通知
- **分離理由**: Claude API呼び出しは数秒かかる重い処理。Webhook応答に影響させないため非同期で実行する。

#### TanStack Start（フルスタック・メインアプリ）

- **役割**: 管理画面SSR + すべてのアプリケーションAPI
- **処理**: `createServerFn`で顧客CRUD、会話一覧、ドラフト承認、Meta Graph API経由のメッセージ送信まで完結
- **設計思想**: フロントとバックが同一コードベース。別途API用Lambdaは不要。

### 3.2 メッセージ処理フロー

```
1. 顧客がメッセージ送信（FB Messenger / Instagram DM）
   ↓
2. Webhook Lambda が受信 → 署名検証 → SQSに投入 → 即200返却
   ↓
3. 分類Lambda がSQSから取得 → Claude APIで分類 + ドラフト生成 → RDSに保存
   ↓
4. Slack通知：「[顧客名] から新着 — [カテゴリ]」
   ↓
5. 管理画面（TanStack Start）で会話 + AIドラフトを確認、編集して「承認して送信」
   ↓
6. TanStack Startサーバー関数 が Meta Graph API経由で送信
```

---

## 4. 技術スタック（確定）

| レイヤー | 技術 | 備考 |
|----------|------|------|
| フロントエンド | TanStack Start | SSR + createServerFnでAPI兼務 |
| ホスティング | Lambda + CloudFront | SSR配信 + 静的アセットキャッシュ |
| Webhook受信 | API Gateway + Lambda（専用） | 軽量、即レスポンス |
| 非同期処理 | SQS + Lambda（専用） | 分類・ドラフト生成パイプライン |
| データベース | RDS Postgres（db.t4g.micro） | 全テーブル格納 |
| ORM | Drizzle ORM | 型安全、軽量、Lambda最適 |
| 認証 | Amazon Cognito | Meta OAuthプロバイダ連携 |
| リアルタイム | ポーリング（v1） → WebSocket（v2） | v1は30秒間隔でuseQuery refetch |
| AI | Claude API（Sonnet） | メッセージ分類 + ドラフト生成 |
| 通知 | Slack Incoming Webhook | v1着信通知、v2でBlock Kit承認 |
| IaC | Terraform | 本業スキル活用、モジュール化管理 |
| デザイン | Claude Design | プロトタイプ → Claude Codeで実装 |

---

## 5. ADR（Architecture Decision Records）

### ADR-001: AWS構成を採用（Cloudflare + Supabase不採用）

- **ステータス**: 承認
- **日付**: 2026-04-18
- **コンテキスト**: Cloudflare Workers + Supabase構成とAWS構成を比較検討した。CF+Supabase構成はコスト面で有利（$7〜32/月 vs $25〜45/月）で、開発速度も速い（Supabase RealtimeやRLSが組み込み）。一方、松原はAWS DVA（Developer Associate）を学習中であり、本業でもAWSを使用している。
- **決定**: AWS構成を採用する。
- **理由**:
  - DVA試験対策として、Lambda / SQS / RDS / Cognito / API Gatewayの実務経験が直接活きる
  - 本業のエンジニアリングスキルとの一貫性
  - 将来のSaaS化において、AWSのサービス組み合わせ自由度が高い
- **トレードオフ**:
  - 開発速度はCF+Supabase構成より遅い（特にRealtime実装とRLS設定）
  - 初年度以降のコストがやや高い（$25-30/月 vs CF+Supabase Pro $32/月で差は小さい）
  - Supabase / Cloudflareは未経験のまま

### ADR-002: Webhook受信を専用Lambdaに分離

- **ステータス**: 承認
- **日付**: 2026-04-18
- **コンテキスト**: TanStack Startのサーバー関数（createServerFn）でWebhookを受信することも技術的には可能。しかしMeta Webhookには20秒以内のレスポンスが必須という制約がある。
- **決定**: Webhook受信は専用の軽量Lambdaに分離する。
- **理由**:
  - TanStack Start本体はバンドルサイズが大きく、コールドスタートが遅い
  - Webhookの即応答（100ms以下）を保証するには、署名検証 + SQS投入だけの最小限の関数が必要
  - Meta側のWebhook無効化を防ぐ
- **トレードオフ**:
  - Lambda関数が1つ増える（管理コストは微増）
  - Terraformモジュールが1つ増える

### ADR-003: TanStack StartでアプリAPIを兼務（別API Lambda不要）

- **ステータス**: 承認
- **日付**: 2026-04-18
- **コンテキスト**: 管理画面のAPIを別途API Gateway + Lambdaで構築するか、TanStack StartのcreateServerFnで処理するかを検討。
- **決定**: TanStack StartのcreateServerFnですべてのアプリAPIを処理する。
- **理由**:
  - フロントとバックが同一コードベースで完結し、型の共有がシームレス
  - 別途API用Lambdaを立てる必要がなく、構成がシンプル
  - 松原が最初に「TanStack Startだったらバックもフロントもいける」と提案した構成に合致
- **トレードオフ**:
  - TanStack Startのバンドルサイズが大きくなるため、コールドスタートはWebhook専用Lambdaより遅い（ただし管理画面なので許容範囲）

### ADR-004: IaCにTerraformを採用（SST不採用）

- **ステータス**: 承認
- **日付**: 2026-04-18
- **コンテキスト**: SST（Serverless Stack）はCDKベースでTanStack Startとの統合が容易、`sst dev`でライブデバッグ可能。一方、松原は本業でTerraformを使用しておりスキル資産がある。
- **決定**: Terraformを採用する。
- **理由**:
  - 本業で使用中のスキルをそのまま活用できる
  - AWS以外のリソース（将来的にStripe、Cloudflare等）も一元管理可能
  - SSTは未経験で学習コストが発生する
- **トレードオフ**:
  - Lambda関数のデプロイサイクルがSSTより遅い（zip化 → S3 → terraform apply）
  - `sst dev`のようなライブデバッグ機能がない（ローカルテストはSAM Local等で補完）
  - DVA試験はCloudFormation/CDK出題だが、概念は共通で応用可能

### ADR-005: Drizzle ORMを採用（Prisma不採用）

- **ステータス**: 承認
- **日付**: 2026-04-18
- **コンテキスト**: TanStack Start自体にはORMが含まれていない。公式ドキュメントではNeonやConvexをDB推奨しているが、ORMはユーザーが選択する設計。候補はDrizzle ORMとPrisma。
- **決定**: Drizzle ORMを採用する。
- **理由**:
  - 約7.4KBで外部依存ゼロ、Lambdaのコールドスタートが約50ms（Prismaはバイナリエンジンでバンドルが大きい）
  - TanStack Start + Drizzleの組み合わせがエコシステムの事実上のスタンダード
  - SQL-likeなAPIで学習コストが低い
  - DB接続先を変えるだけで他のPostgresに移行可能（将来Supabaseに乗り換える場合も最小限の変更）
- **トレードオフ**:
  - Prismaほどのマイグレーション管理機能の成熟度はない
  - Prisma Studioのような組み込みGUIはない

### ADR-006: v1のリアルタイム更新はポーリングで実装（WebSocket不採用）

- **ステータス**: 承認
- **日付**: 2026-04-18
- **コンテキスト**: 管理画面に新着メッセージをリアルタイムで表示したい。選択肢はAPI Gateway WebSocketとHTTPポーリング。
- **決定**: v1は30秒間隔のHTTPポーリング（useQueryのrefetchInterval）で実装する。
- **理由**:
  - API Gateway WebSocketは接続管理用DynamoDBテーブル + 接続/切断/メッセージ用の3つのLambdaが必要で実装コストが高い
  - 月300件（1日10件程度）なら30秒ポーリングで十分実用的
  - TanStack QueryのrefetchIntervalなら数行で実装可能
- **トレードオフ**:
  - 新着メッセージの表示に最大30秒の遅延がある
  - ユーザー増加時にはポーリングのリクエスト数が増える
  - Phase 2で必要に応じてWebSocket化を検討

### ADR-007: DynamoDBではなくRDS Postgresを採用

- **ステータス**: 承認
- **日付**: 2026-04-18
- **コンテキスト**: DynamoDBはコスト面で有利（25GB無料枠、小規模ならほぼ$0）だが、このアプリのデータ構造は「顧客 → 会話 → メッセージ」というリレーショナルな親子関係が中心。
- **決定**: RDS Postgres（db.t4g.micro）を採用する。
- **理由**:
  - リレーショナルなJOIN + WHEREクエリが頻出（「VIP顧客の過去30日の会話を最新メッセージ付きで一覧」等）
  - マルチテナント分離にRow Level Security（RLS）がPostgresネイティブで使える
  - DynamoDBではGSI設計を事前に決め打ちする必要があり、クエリの柔軟性が低い
  - Drizzle ORMとの相性が良い
- **トレードオフ**:
  - RDS無料枠は12ヶ月限定（以降〜$15-20/月）
  - DynamoDBの25GB永久無料枠は使えない
  - RDSはサーバーが常時稼働するため、DynamoDBのオンデマンド課金より高い

### ADR-008: Claude Designでデザイン → Claude Codeで実装

- **ステータス**: 承認
- **日付**: 2026-04-18
- **コンテキスト**: UIデザインツールの選定。Figma、手書きモックアップ、Claude Designが候補。
- **決定**: Claude Designでプロトタイプ作成 → Claude Codeで実装のワークフローを採用。
- **理由**:
  - Claude Designはテキストプロンプトからプロトタイプを生成でき、デザイナー不要
  - デザインシステム（色・タイポグラフィ・コンポーネント）をClaude Designで統一し、実装時の参照資料にできる
  - PDF/URL/PPTX出力に対応しており、チーム共有も可能
  - 2026年4月17日ローンチの最新ツールで、Opus 4.7ベースの高品質なデザイン生成
- **トレードオフ**:
  - リサーチプレビュー段階で機能が変更される可能性がある
  - Figmaほどのピクセルレベルの精密な制御はできない

---

## 6. 月額コスト試算（1人運用 × 月300件）

| サービス | 初年度 | 2年目以降 |
|----------|--------|-----------|
| Lambda × 3 | 無料枠内 | 無料枠内（永久） |
| API Gateway (REST) | 〜$1 | 〜$1 |
| SQS | 無料枠内 | 無料枠内（永久） |
| RDS Postgres | 無料枠内 | 〜$15-20 |
| Cognito | 無料枠内 | 無料枠内（永久、50K MAU） |
| CloudFront | 〜$1 | 〜$1 |
| Claude API (Sonnet) | 〜$2-5 | 〜$2-5 |
| CloudWatch | 〜$3 | 〜$3 |
| **合計** | **〜$7-10/月** | **〜$25-30/月** |

※ AWS無料枠について: MalbekのAWSアカウントが2025年7月15日以前に作成されている場合は旧制度（12ヶ月無料枠）が適用。7月15日以降のアカウントは新制度（$200クレジット制、最大6ヶ月）が適用される。

---

## 7. 開発フェーズ

### Phase 0: 準備（Meta App Review待ち — 1〜2週間）

- [ ] **[ブロッカー]** Meta Business Verification申請 + アプリ作成
- [ ] **[基盤]** Terraform構成ファイル作成（Lambda×3 + API GW + SQS + RDS + Cognito）
- [ ] **[基盤]** RDS Postgres + Drizzle ORMセットアップ、DBスキーマ設計
- [ ] **[基盤]** TanStack Startプロジェクト初期構築 + Lambdaデプロイ確認
- [ ] **[デザイン]** Claude Designで管理画面プロトタイプ（会話一覧・スレッド・顧客管理）
- [ ] **[中核]** 顧客管理CRUD画面 — VIPタグ、メモ、購入履歴
- [ ] **[中核]** 商品マスタ簡易登録（手動入力）

### Phase 1: MVP（Meta App Review承認後 — 2〜3週間）

- [ ] **[中核]** Webhook Lambda：署名検証 + SQSエンキュー
- [ ] **[中核]** 分類Lambda：Claude API分類 + ドラフト生成 + RDS保存
- [ ] **[中核]** TanStack Start：会話スレッド表示 + ドラフト承認UI
- [ ] **[中核]** サーバー関数：Meta Graph API経由メッセージ送信
- [ ] **[追加]** Slack Incoming Webhook通知
- [ ] **[追加]** ポーリング新着更新（30秒間隔）

### Phase 2: 自動化拡張（運用安定後 — 1〜2ヶ月後）

- [ ] **[中核]** 在庫・価格DB連携（Shopify API / スプレッドシート同期）
- [ ] **[中核]** PayPal/Wise請求リンク自動生成
- [ ] **[中核]** 追跡番号の自動返信
- [ ] **[追加]** API Gateway WebSocketでリアルタイム通知に置換
- [ ] **[追加]** VIP顧客の自動ルーティング
- [ ] **[追加]** Slack Block Kit + Boltで承認ボタン

### Phase 3: SaaS化（3〜6ヶ月後）

- [ ] **[中核]** Cognito Meta OAuthで他セラーがページ接続
- [ ] **[中核]** テナント分離（RDS RLS）
- [ ] **[中核]** 課金機能（Stripe Billing）
- [ ] **[追加]** テナント別カスタムプロンプト設定
- [ ] **[追加]** 分析ダッシュボード（応答時間、カテゴリ分布）

---

## 8. 次のタスク（Phase 0 着手順）

Phase 0のタスクは以下の順序で着手する。Meta審査は時間がかかるため最優先で申請し、待ちの間にインフラとアプリ開発を並行して進める。

### 8.1 Meta App Review申請（最優先・ブロッカー）

1. Meta for Developersでアプリ作成
2. Business Verification申請（Malbek法人情報の提出）
3. Messenger Platform + Instagram Graph APIの権限申請
4. Webhook検証用エンドポイントの準備（申請時に必要）

### 8.2 Terraformモジュール設計

モジュール構成:
- `modules/webhook` — API Gateway + Webhook Lambda
- `modules/classifier` — SQS + 分類Lambda
- `modules/app` — TanStack Start Lambda + CloudFront
- `modules/database` — RDS Postgres + セキュリティグループ
- `modules/auth` — Cognito ユーザープール + Meta OAuthプロバイダ

### 8.3 DBスキーマ設計（Drizzle ORM）

テーブル構成:
- `tenants` — テナント（セラー）情報
- `customers` — 顧客情報（VIPタグ、メモ）
- `conversations` — 会話スレッド（チャネル、ステータス）
- `messages` — 個別メッセージ（送信者、本文、タイムスタンプ）
- `draft_replies` — AIが生成した返信ドラフト（分類結果、承認ステータス）
- `products` — 商品マスタ（名前、価格、在庫状況）

### 8.4 Claude Design でUIプロトタイプ

作成する画面:
- 会話一覧（受信トレイ形式、カテゴリ別フィルタ、未読バッジ）
- 会話スレッド詳細（メッセージ履歴 + AIドラフト + 承認ボタン）
- 顧客管理（顧客一覧、VIPタグ、購入履歴、メモ）
- 商品管理（商品一覧、価格、在庫状況）

### 8.5 Claude API 分類プロンプト設計

6カテゴリ分類 + 返信ドラフト生成のプロンプトを設計:
- 入力: メッセージ本文 + 顧客情報 + 商品コンテキスト
- 出力: 分類カテゴリ + 信頼度スコア + 返信ドラフト（英語）

---

## 9. 将来の移行パス

Cloudflare + Supabase構成への移行が必要になった場合のリスク評価:

| レイヤー | 移行難易度 | 備考 |
|----------|-----------|------|
| DB (Postgres → Postgres) | 簡単 | pg_dump/restoreで完了。Drizzle ORMなら接続先変更のみ |
| Claude API | 変更なし | HTTP呼び出しなのでどこで動いても同じ |
| Slack通知 | 変更なし | 同上 |
| SQS → Cloudflare Queues | 中程度 | エンキュー/デキューのAPI書き換え |
| リアルタイム → Supabase Realtime | 中程度 | クライアント側リスナー + サーバー側の書き換え |
| Cognito → Supabase Auth | 書き換え | 認証フロー全体の再実装が必要 |
