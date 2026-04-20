# Implementation Plan: MVP for Meta App Review Submission

**Branch**: `001-mvp-app-review` | **Date**: 2026-04-20 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-mvp-app-review/spec.md`

## Summary

Meta App Review 通過に必要な最小機能（Messenger 受信 → 管理画面で確認・編集 → Send API で返信）を実装する。design v2 の目的地である TanStack Start + AWS 構成への「ブリッジ」として、**TanStack Start モノリスを単一 Lambda にデプロイ**し、Webhook も同 Lambda 内で処理する。RDS Postgres と Terraform は design v2 と共通化。AI 分類 Lambda / SQS / Cognito は MVP では導入せず、審査通過後に Phase 2 で段階的に追加する。

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 20.x (AWS Lambda ランタイム `nodejs20.x`)
**Primary Dependencies**:
- `@tanstack/react-start` — SSR + `createServerFn` でフロント API を兼務
- `drizzle-orm` + `postgres` — 型安全な Postgres アクセス、Lambda 最適化
- `@aws-sdk/client-cognito-identity-provider` — Cognito `InitiateAuth` / `GlobalSignOut` 呼び出し
- `aws-jwt-verify` — Cognito が発行する JWT（ID Token / Refresh Token）の署名検証、JWKS 自動キャッシュ
- `zod` — Webhook ペイロードと API 入出力の検証
- `@aws-sdk/client-ssm` — Page Access Token 等のシークレット取得

**Storage**: AWS RDS Postgres `db.t4g.micro`（無料枠）。全テーブルを単一インスタンスに格納。接続は VPC 内 Lambda から直接（RDS Proxy は MVP では省略）。

**Testing**:
- `vitest` — ユニット + 統合テスト（Webhook 署名検証、Send API モック、DB マイグレーション適用後の CRUD）
- `playwright` — 受信 → 返信送信の E2E スモーク（ローカル + プレビュー環境）
- Meta 側の実機疎通は手動スモーク（テスト FB ページ + Messenger アプリ）

**Target Platform**: AWS Lambda + API Gateway（HTTP API）+ RDS + Cognito User Pool。独自ドメイン配下に CloudFront 経由で配信。

**Project Type**: Web application — TanStack Start モノリス 1 本（SSR + API + Webhook 受信 + 公開ページすべて同一アプリ）。

**Performance Goals**:
- Webhook Lambda のコールドスタート + 処理時間で p95 < 5 秒、p99 < 15 秒（Meta の 20 秒 SLA に十分なマージン）
- 管理画面の初期表示 p95 < 3 秒（CloudFront キャッシュ + Lambda ウォーム時）
- Send API 呼び出しは p95 < 3 秒で応答

**Constraints**:
- **Meta Webhook は 20 秒以内に 200 必須**：MVP では同期処理（署名検証 → DB insert → 200）で収まる見込みだが、処理時間が 10 秒を超えるようなら Phase 2 で SQS 分離する ADR 条項を発動する。
- **HTTPS 必須**：API Gateway のデフォルト証明書 or ACM 証明書 + CloudFront で独自ドメイン配下を HTTPS 化。
- **24/7 稼働**：Lambda は常時起動不要（オンデマンド）だが、RDS は常時稼働。審査期間中は RDS を停止しない運用ルールを設ける。
- **Page Access Token の長期化**：Meta Graph API で `fb_exchange_token` を介して長期トークン化し SSM Parameter Store に格納。
- **ユーザー認証**：Cognito User Pool 管理。DB にユーザーテーブル／セッションテーブルを持たず、JWT を HttpOnly Cookie で扱うステートレスセッション。

**Scale/Scope**:
- 想定アクセス：審査期間中のレビュワー 1〜2 名 + 自社オペレーター 1 名 = **同時ユーザー 3 名程度**
- 想定メッセージ数：審査中の手動テストで 1 日 10〜30 件程度
- 画面数：管理画面 2 画面（受信一覧、スレッド詳細）+ ログイン画面 + 公開ページ 4 種（プライバシー、利用規約、データ削除、会社情報）= 7 画面
- LOC 目安：~2000 行（バックエンドサービス含む）

## Constitution Check

*GATE: Phase 0 研究の前に必ずパス、Phase 1 設計後に再チェック。*

**プロジェクト憲法の状態**: `.specify/memory/constitution.md` は未ラティファイ（テンプレートのまま）。本プランでは業界標準のゲートを暫定適用する：

| ゲート | 判定 | 根拠 |
|--------|------|------|
| **YAGNI（不要機能を入れない）** | ✅ PASS | 仕様の Out of Scope を厳守。AI 分類、Instagram DM、Slack 通知、顧客管理、商品管理、マルチテナント、トーン設定はすべて除外済み。 |
| **単一責任（1 機能 1 ストーリー）** | ✅ PASS | User Story 1〜5 が独立テスト可能で、それぞれ独立にデモできる。 |
| **テスト可能性** | ✅ PASS | Webhook 署名検証・送信ロジック・認証はユニットテスト可能。受信→送信フローは E2E で検証可能。 |
| **シンプル優先（Lambda 3 本 → 1 本に集約）** | ✅ PASS | MVP 規模では Webhook 分離不要。ADR-002 のトリガー条件（Meta Webhook 20 秒制約）は同期処理で十分満たせる。複雑さの正当化は不要。 |
| **観測性** | ✅ PASS | CloudWatch Logs に構造化ログ出力。Webhook 受信・送信成功/失敗・署名検証失敗をすべて記録。 |
| **可逆性（Phase 2 への移行容易性）** | ✅ PASS | TanStack Start の route を分離するだけで Webhook Lambda を独立 Lambda に切り出し可能。DB スキーマは Phase 2 と共通。 |

**複雑性の正当化**: なし（Complexity Tracking セクションは空で提出）。

## Project Structure

### Documentation (this feature)

```text
specs/001-mvp-app-review/
├── spec.md              # 仕様書（作成済み）
├── plan.md              # 本ファイル
├── research.md          # Phase 0 成果物（後述）
├── data-model.md        # Phase 1 成果物（後述）
├── quickstart.md        # Phase 1 成果物（後述）
├── contracts/           # Phase 1 成果物（後述）
│   ├── meta-webhook.md
│   ├── meta-send-api.md
│   ├── data-deletion-callback.md
│   └── admin-api.md
├── checklists/
│   └── requirements.md  # 品質チェックリスト（作成済み）
└── tasks.md             # /speckit.tasks で生成
```

### Source Code (repository root)

```text
app/                              # TanStack Start アプリ
├── src/
│   ├── routes/
│   │   ├── __root.tsx            # 共通レイアウト
│   │   ├── (public)/             # 非認証・公開ページ
│   │   │   ├── index.tsx         # 会社情報（TOP）
│   │   │   ├── privacy.tsx       # プライバシーポリシー
│   │   │   ├── terms.tsx         # 利用規約
│   │   │   └── data-deletion.tsx # データ削除手順
│   │   ├── (auth)/
│   │   │   └── login.tsx
│   │   ├── (app)/                # 認証必須・管理画面
│   │   │   ├── inbox.tsx         # 受信一覧
│   │   │   └── threads.$id.tsx   # スレッド詳細 + 返信送信
│   │   └── api/
│   │       ├── webhook.ts        # Meta Webhook 受信（GET 検証 + POST 受信）
│   │       └── data-deletion.ts  # Meta データ削除コールバック
│   ├── server/
│   │   ├── db/
│   │   │   ├── schema.ts         # Drizzle スキーマ（4 エンティティ）
│   │   │   ├── client.ts         # 接続プール
│   │   │   └── migrations/       # drizzle-kit が生成
│   │   ├── services/
│   │   │   ├── messenger.ts      # Send API ラッパー
│   │   │   ├── webhook.ts        # 署名検証 + 冪等挿入
│   │   │   ├── auth.ts           # Cognito InitiateAuth / GlobalSignOut + JWT 検証
│   │   │   └── token.ts          # Page Access Token 取得（SSM）
│   │   └── env.ts                # 環境変数スキーマ
│   ├── components/
│   │   ├── Inbox.tsx             # mock/inbox-screens.jsx を参考
│   │   ├── Thread.tsx
│   │   └── LoginForm.tsx
│   └── styles/
├── tests/
│   ├── unit/
│   │   ├── webhook-signature.test.ts
│   │   ├── messenger-service.test.ts
│   │   └── auth.test.ts
│   ├── integration/
│   │   ├── webhook-receive.test.ts    # Meta ペイロードの実形で流す
│   │   └── send-reply.test.ts
│   └── e2e/
│       └── review-flow.spec.ts        # Playwright: ログイン→受信→返信
├── drizzle.config.ts
├── package.json
└── tsconfig.json

terraform/                         # AWS インフラ定義
├── main.tf
├── variables.tf
├── providers.tf
├── modules/
│   ├── app-lambda/                # TanStack Start Lambda + API Gateway + CloudFront
│   ├── database/                  # RDS Postgres + セキュリティグループ
│   ├── auth/                      # Cognito User Pool + App Client + Groups + 初期ユーザー
│   └── secrets/                   # SSM Parameter Store
└── envs/
    └── review/                    # 審査用環境（tfvars）

docs/
├── review-submission/             # 審査提出用資料
│   ├── use-case-description.md    # 権限ごとの用途説明（英語）
│   ├── screencast-script.md       # スクリーンキャスト撮影台本
│   └── reviewer-credentials.md    # レビュワー用テストアカウント情報
└── operations/
    └── audit-runbook.md           # 審査期間中の監視・運用手順
```

**Structure Decision**: TanStack Start モノリスで 1 アプリ構成。Webhook・API・SSR・公開ページすべて同一アプリに収容し、単一 Lambda にデプロイする。tests は `app/tests/` に unit / integration / e2e の 3 階層で配置。Terraform は `terraform/` にルート + モジュール構成で、審査用環境（`envs/review/`）のみ定義する。Phase 2 で Webhook を別 Lambda に分離する際は、`app/src/routes/api/webhook.ts` のロジックを独立 Lambda に複製 → API Gateway のルーティングを分離、という移行パス。

## Complexity Tracking

> Constitution Check で違反なし。本セクションは空。
