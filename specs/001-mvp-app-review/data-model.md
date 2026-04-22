# Phase 1: Data Model

**Feature**: MVP for Meta App Review Submission
**Branch**: `001-mvp-app-review`
**Date**: 2026-04-20
**Storage**: AWS RDS Postgres 15 (`db.t4g.micro`)
**ORM**: Drizzle ORM
**Authentication**: Amazon Cognito User Pool（DB にユーザー／セッション情報を持たない）

MVP ではシングルテナント前提のため、`tenants` / `products` / `customers`（メタデータ付与版）は持たない。

認証は Cognito User Pool に委譲し、`admin_users` / `sessions` テーブルは持たない（R-002 参照）。Cognito の `sub`（ユーザー一意 ID）を DB 側の外部参照として保持するのみ。

以下 3 エンティティ + 監査用 1 エンティティ（削除ログ）のみを DB に持つ。Phase 2 で `tenants` / `products` / `customers` メタデータを追加する際は、`connected_pages.tenant_id` / `conversations.customer_id` を外部キーとして接続する設計上の余地を残す。

---

## Entity: `connected_pages`

連携済みの Facebook ページ。MVP では 1 行のみ。

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `uuid` | PK | `gen_random_uuid()` |
| `page_id` | `varchar(64)` | UNIQUE NOT NULL | Facebook ページ ID |
| `page_name` | `varchar(255)` | NOT NULL | 表示名 |
| `page_access_token_ssm_key` | `varchar(255)` | NOT NULL | SSM Parameter Store のキー（実トークンは DB に入れない）。MVP の seed 値は `/fumireply/review/meta/page-access-token`（`infrastructure.md` §3.4 と一致） |
| `webhook_verify_token_ssm_key` | `varchar(255)` | NOT NULL | Webhook 購読時の verify_token の SSM キー。MVP の seed 値は `/fumireply/review/meta/webhook-verify-token` |
| `connected_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `is_active` | `boolean` | NOT NULL DEFAULT `true` | 停止時に `false` |

**Indexes**: `page_id`（UNIQUE）

**設計意図**: トークン本体は DB に保存せず、SSM Parameter Store の `SecureString` に分離（R-005 参照）。DB からトークンを漏らさない。

---

## Entity: `conversations`

特定の顧客（Messenger ユーザー）と連携ページとの会話スレッド。

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `uuid` | PK | |
| `page_id` | `uuid` | FK → `connected_pages.id` NOT NULL | |
| `customer_psid` | `varchar(64)` | NOT NULL | Meta Page-Scoped ID |
| `customer_name` | `varchar(255)` | NULL | Meta Graph API `/me` から取得（取れない場合 NULL） |
| `last_inbound_at` | `timestamptz` | NULL | 24 時間窓カウントダウン用 |
| `last_message_at` | `timestamptz` | NULL | スレッド並び替え用 |
| `unread_count` | `integer` | NOT NULL DEFAULT `0` | 受信トレイバッジ用 |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

**Indexes**:
- UNIQUE (`page_id`, `customer_psid`)
- INDEX (`page_id`, `last_message_at` DESC) — 受信一覧の並び替え用

**状態遷移**:
- 初回メッセージ受信時に INSERT
- 受信時: `last_inbound_at`, `last_message_at`, `unread_count++` を更新
- 送信時: `last_message_at` を更新
- 管理画面でスレッドを開いた時: `unread_count = 0` にリセット

---

## Entity: `messages`

個別のメッセージ（受信・送信の両方）。

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `uuid` | PK | |
| `conversation_id` | `uuid` | FK → `conversations.id` NOT NULL | |
| `direction` | `varchar(10)` | NOT NULL, CHECK (`direction IN ('inbound','outbound')`) | |
| `meta_message_id` | `varchar(128)` | UNIQUE NULL | Meta の `mid`。冪等性キー。送信時は Send API レスポンスから取得 |
| `body` | `text` | NOT NULL | 空文字も許容（スタンプのみ等） |
| `message_type` | `varchar(20)` | NOT NULL DEFAULT `'text'` | `text` / `sticker` / `image` / `other` |
| `timestamp` | `timestamptz` | NOT NULL | Meta の `timestamp` を採用。送信時は `now()` |
| `send_status` | `varchar(20)` | NULL, CHECK (`send_status IN ('sent','failed','pending')` OR NULL) | inbound は NULL、outbound は必須 |
| `send_error` | `text` | NULL | 送信失敗時の理由 |
| `sent_by_cognito_sub` | `varchar(64)` | NULL | outbound のみ。Cognito ユーザー `sub`（UUID 文字列）。FK は張らない（Cognito 側は外部システム） |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

**Indexes**:
- UNIQUE (`meta_message_id`) where `meta_message_id IS NOT NULL` — 冪等性
- INDEX (`conversation_id`, `timestamp` ASC) — スレッド表示
- INDEX (`sent_by_cognito_sub`) where `direction='outbound'` — 監査ログ検索用

**設計意図**:
- `meta_message_id` の UNIQUE で Meta Webhook の重複配信に対して冪等に動作する（INSERT ... ON CONFLICT DO NOTHING）。
- 送信時も Send API レスポンスの `message_id` を `meta_message_id` に保存し、echo webhook で返ってきた場合の重複表示を防ぐ。
- `body` が空でも INSERT できるようにし、スタンプ・画像等のノンテキストメッセージを失わない。
- `sent_by_cognito_sub` は Cognito の `sub` 属性（例: `a1b2c3d4-xxxx-xxxx-xxxx-xxxxxxxxxxxx`）を平文保存。Cognito ユーザーの削除が起きても履歴は残す（監査要件のため）。

**状態遷移（outbound）**:
- ユーザーが送信ボタン → INSERT (`send_status='pending'`, `sent_by_cognito_sub=JWT.sub`)
- Send API 呼び出し成功 → UPDATE (`send_status='sent'`, `meta_message_id=レスポンスの message_id`)
- Send API 呼び出し失敗 → UPDATE (`send_status='failed'`, `send_error=エラーメッセージ`)

---

## Entity: `deletion_log`

Meta のデータ削除コールバックに対する削除実行の監査ログ（R-004 / `contracts/data-deletion-callback.md` 参照）。

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `uuid` | PK | |
| `psid_hash` | `varchar(64)` | NOT NULL | 削除対象の Meta PSID の **SHA-256 ハッシュ**（平文 PSID は保存しない） |
| `confirmation_code` | `varchar(32)` | UNIQUE NOT NULL | Meta への応答・ステータス確認 URL 用 |
| `deleted_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

**Indexes**:
- `confirmation_code`（UNIQUE）
- `psid_hash`（INDEX、同一 PSID に対する重複削除リクエストの冪等性確認用）

**設計意図**:
- **平文 PSID を保存しない**：監査要件は「この PSID に対して削除処理を実行した事実」の証明であり、PSID そのものの特定は不要。漏洩時の影響を最小化するため一方向ハッシュで保存する。
- ハッシュ計算時にはアプリ固有の salt（SSM Parameter Store `/fumireply/review/deletion-log/hash-salt` で管理）を結合し、Meta 側データベースとの突合攻撃を防ぐ：`sha256(salt || psid)`。
- `confirmation_code` は漏洩しても PSID を逆引きできない（ランダム UUID）。
- status URL は現状通り認証なしで公開（Meta 仕様要件）。ただし返却するのは「Deleted」だけで、PSID や他の個人情報を含まない。

**保存期間**: **3 年間保持**。当初は 7 年案だったが、GDPR の「必要最小限」原則とのバランスで 3 年に短縮。監査対応と最小化原則の折衷。3 年経過後は自動削除（Phase 2 で cron バッチ実装、MVP では `audit-runbook.md` に手動 cleanup 手順を記載）。

**プライバシーポリシーへの記載**: 削除証跡を 3 年間 SHA-256 ハッシュ化形式で保持する旨を明示。

---

## Authentication（Cognito User Pool）

### User Pool 属性

| 属性 | 用途 |
|------|------|
| `sub` | Cognito 内部の一意 ID（UUID）。DB の `sent_by_cognito_sub` と突合 |
| `email` | ログイン ID + 通知宛先 |
| `email_verified` | MVP では作成時に true 固定 |

MVP ではカスタム属性（`custom:role` 等）は**使用しない**。ロール管理は次節の User Pool Groups で行う。

### User Pool Groups（ロール管理の正式方式）

ロール管理は Cognito User Pool Groups を採用する。JWT の `cognito:groups` クレームから権限を判定する：

- グループ `operators` — Malbek 運用者
- グループ `reviewers` — Meta 審査用テストアカウント

**採用理由**:
- `cognito:groups` クレームが JWT に自動的に入る（権限判定が追加 API 呼び出し不要）
- IAM Role の割当てが必要になった時にグループ単位で簡単に制御できる
- DVA 試験範囲として Groups の概念を実践できる

**代替案として検討した `custom:role`**: カスタム属性を JWT に載せる方式は、属性変更時に ID Token を再発行する必要があり、Groups より運用が煩雑。MVP では採用しない。

**`contracts/admin-api.md` との対応**: `serverFn: login` のレスポンスの `user.role` は `cognito:groups` の先頭要素から派生させる（`operators` → `'operator'`、`reviewers` → `'reviewer'`）。

### 初期ユーザー（Terraform 側で作成）

| email | グループ | 備考 |
|-------|---------|------|
| `operator@malbek.co.jp` | `operators` | Malbek 運用者 |
| `reviewer@malbek.co.jp` | `reviewers` | Meta レビュワー用（IP 制限・2FA なし） |

Terraform の `aws_cognito_user` リソースで作成、初期パスワードは SSM Parameter Store から取得し、初回ログイン時に変更を促す（ただし審査用 `reviewer` アカウントは初期パスワードのまま固定する）。

### セッション方式

DB にセッションテーブルを**持たない**（ステートレス）。

- ログイン時：Cognito が ID Token（1 時間） + Refresh Token（30 日） + Access Token を発行
- アプリはそれらを HttpOnly Cookie にセット
- 毎リクエストで JWT 署名検証（`aws-jwt-verify` + JWKS キャッシュ）
- ID Token 期限切れ時は Refresh Token で再発行

詳細は [`contracts/admin-api.md`](./contracts/admin-api.md) の認証ミドルウェア節と R-002 を参照。

---

## Relationships

```
connected_pages (1) ─── (*) conversations [page_id]
conversations   (1) ─── (*) messages      [conversation_id]
Cognito User     ─── (*) messages         [sent_by_cognito_sub, 論理参照のみ]
```

外部キーは ON DELETE RESTRICT（削除はデータ削除コールバックでカスケード手動実行）。

---

## データ削除の扱い

Meta の Data Deletion Callback で削除対象 PSID が送られてきた場合：

1. `conversations` で `customer_psid = 対象 PSID` の行を取得
2. 当該 `conversation.id` に紐づく `messages` を DELETE
3. `conversations` を DELETE
4. `deletion_log` に INSERT（監査ログ）
5. `confirmation_code` を Meta に URL + code として返す

SSM Parameter Store / connected_pages / Cognito User Pool は削除対象外。

---

## マイグレーション戦略

- `drizzle-kit generate` でマイグレーション SQL を生成
- PR レビューで目視確認後にマージ
- ローカル or CI から `drizzle-kit migrate` を実行
- Lambda 起動時の自動マイグレーションは実装しない（R-006）

初期マイグレーション（`0001_init.sql`）には以下を含める：
- 全 4 テーブル（`connected_pages`, `conversations`, `messages`, `deletion_log`）の CREATE
- `connected_pages` の seed（Malbek のテスト FB ページ情報）。SSM キー名は以下の固定値を用いる：
  - `page_access_token_ssm_key = '/fumireply/review/meta/page-access-token'`
  - `webhook_verify_token_ssm_key = '/fumireply/review/meta/webhook-verify-token'`
  - `page_id` / `page_name` は運用時に確定させる（seed では placeholder、`npm run db:seed:review` 実行前に envs/review 用の実値に差し替える）

Cognito ユーザーは Terraform（`terraform/modules/auth`）で管理し、DB マイグレーションには含めない。
