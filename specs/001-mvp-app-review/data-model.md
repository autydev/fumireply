# Phase 1: Data Model

**Feature**: MVP for Meta App Review Submission
**Branch**: `001-mvp-app-review`
**Date**: 2026-04-20
**Updated**: 2026-04-30 (Supabase Postgres + ai_drafts テーブル追加 + Cognito 廃止)
**Storage**: Supabase Postgres（東京リージョン、無料プラン）
**ORM**: Drizzle ORM
**Authentication**: Supabase Auth（DB にユーザー／セッション情報を持たない）

MVP ではシングルテナント前提のため、`tenants` / `products` / `customers`（メタデータ付与版）は持たない。**RLS（Row Level Security）も MVP / Phase 2 を通じて採用しない**（運用者 1〜2 名が自分のデータを見るだけのシングルテナント運用のため）。

認証は Supabase Auth に委譲し、`admin_users` / `sessions` テーブルは持たない（R-002 参照）。Supabase Auth の `auth.users.id`（UUID）を DB 側の外部参照として保持するのみ。アプリ DB と Supabase Auth は同一 Supabase プロジェクト内に存在するが、`auth` スキーマには直接 JOIN せず、UUID 文字列の論理参照とする。

以下 4 エンティティ + 監査用 1 エンティティ（削除ログ）の計 5 テーブルを DB に持つ。

---

## Entity: `connected_pages`

連携済みの Facebook ページ。MVP では 1 行のみ。

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `uuid` | PK | `gen_random_uuid()` |
| `page_id` | `varchar(64)` | UNIQUE NOT NULL | Facebook ページ ID |
| `page_name` | `varchar(255)` | NOT NULL | 表示名 |
| `page_access_token_ssm_key` | `varchar(255)` | NOT NULL | SSM Parameter Store のキー（実トークンは DB に入れない）。MVP の seed 値は `/fumireply/review/meta/page-access-token` |
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
| `customer_name` | `varchar(255)` | NULL | Phase 2 で取得（MVP は NULL）|
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
| `meta_message_id` | `varchar(128)` | UNIQUE NULL | Meta の `mid`。冪等性キー |
| `body` | `text` | NOT NULL | 空文字も許容（スタンプのみ等） |
| `message_type` | `varchar(20)` | NOT NULL DEFAULT `'text'` | `text` / `sticker` / `image` / `other` |
| `timestamp` | `timestamptz` | NOT NULL | Meta の `timestamp` を採用。送信時は `now()` |
| `send_status` | `varchar(20)` | NULL, CHECK (`send_status IN ('sent','failed','pending')` OR NULL) | inbound は NULL、outbound は必須 |
| `send_error` | `text` | NULL | 送信失敗時の理由 |
| `sent_by_auth_uid` | `uuid` | NULL | outbound のみ。Supabase Auth の `auth.users.id`（UUID）。FK は張らない（auth スキーマへの依存を避ける）|
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

**Indexes**:
- UNIQUE (`meta_message_id`) where `meta_message_id IS NOT NULL` — 冪等性
- INDEX (`conversation_id`, `timestamp` ASC) — スレッド表示
- INDEX (`sent_by_auth_uid`) where `direction='outbound'` — 監査ログ検索用

**設計意図**:
- `meta_message_id` の UNIQUE で Meta Webhook の重複配信に対して冪等に動作する（INSERT ... ON CONFLICT DO NOTHING）。
- 送信時も Send API レスポンスの `message_id` を `meta_message_id` に保存し、echo webhook で返ってきた場合の重複表示を防ぐ。
- `body` が空でも INSERT できるようにし、スタンプ・画像等のノンテキストメッセージを失わない。
- `sent_by_auth_uid` は Supabase Auth の `id` 属性（UUID）を保存。Supabase Auth ユーザーの削除が起きても履歴は残す（監査要件のため）。

**状態遷移（outbound）**:
- ユーザーが送信ボタン → INSERT (`send_status='pending'`, `sent_by_auth_uid=JWT.sub`)
- Send API 呼び出し成功 → UPDATE (`send_status='sent'`, `meta_message_id=レスポンスの message_id`)
- Send API 呼び出し失敗 → UPDATE (`send_status='failed'`, `send_error=エラーメッセージ`)

---

## Entity: `ai_drafts`

inbound メッセージに対して Worker Lambda（Anthropic Claude Haiku 4.5）が生成した返信下書き。MVP コア機能（FR-022〜FR-026）。

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `uuid` | PK | `gen_random_uuid()` |
| `message_id` | `uuid` | FK → `messages.id` NOT NULL UNIQUE | 1 inbound メッセージにつき下書き 1 件（再生成時は UPDATE）|
| `status` | `varchar(20)` | NOT NULL, CHECK (`status IN ('pending','ready','failed')`) | 生成状態 |
| `body` | `text` | NULL | 生成された下書き本文。`status='ready'` の時のみ NOT NULL |
| `model` | `varchar(64)` | NULL | 使用モデル（例: `claude-haiku-4-5-20251001`） |
| `error` | `text` | NULL | 生成失敗時の理由（API エラー、timeout 等）|
| `prompt_tokens` | `integer` | NULL | 入力トークン数（コスト分析用）|
| `completion_tokens` | `integer` | NULL | 出力トークン数 |
| `latency_ms` | `integer` | NULL | Anthropic API 呼び出し開始〜レスポンス受信の経過時間（ms）|
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | INSERT 時刻（Webhook 受信 → enqueue 直後）|
| `updated_at` | `timestamptz` | NOT NULL DEFAULT `now()` | Worker が status を更新した時刻 |

**Indexes**:
- UNIQUE (`message_id`) — 1 メッセージ 1 下書きを保証
- INDEX (`status`) — `pending` 状態のクエリ用（Phase 2 でリトライバッチを書くなら使う）

**状態遷移**:
- Webhook 受信 Lambda が `messages` insert と同時に `ai_drafts` を `status='pending'` で INSERT し、SQS にメッセージを enqueue
- Worker Lambda が SQS メッセージを受信 → Anthropic API 呼び出し
- 成功時：UPDATE (`status='ready'`, `body`, `model`, `prompt_tokens`, `completion_tokens`, `latency_ms`, `updated_at=now()`)
- 失敗時：UPDATE (`status='failed'`, `error`, `latency_ms`, `updated_at=now()`)
- リトライ時（DLQ から手動再投入 or Phase 2 バッチ）：UPDATE で再生成

**設計意図**:
- スレッド画面が `messages` JOIN `ai_drafts` で受信メッセージごとに下書きの有無を取得できる。
- `status='pending'` の場合は画面に「下書き生成中…」を表示（FR-024）。
- `status='failed'` の場合は空入力で送信できる（FR-025）。
- 完全自動送信を防ぐため、`ai_drafts` には**送信トリガとなるカラムがない**（FR-026）。送信は `messages` の outbound 行を作成する別パスで行う。
- トークン数 / レイテンシをカラムに持つことで、運用後にコスト分析・モデル見直しが容易。

**プライバシー**:
- 削除コールバック（FR-014）で `conversations` を削除する際、`ai_drafts` も連鎖的に削除する（`messages` の CASCADE 削除でカバー、または明示的に DELETE）。
- プライバシーポリシーには「AI 下書き生成のために Anthropic にメッセージ本文を送信する」旨を明記（R-008）。

---

## Entity: `deletion_log`

Meta のデータ削除コールバックに対する削除実行の監査ログ（R-004 / `contracts/data-deletion-callback.md` 参照）。

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `uuid` | PK | |
| `psid_hash` | `varchar(64)` | NOT NULL | 削除対象の Meta PSID の **SHA-256 ハッシュ**（平文 PSID は保存しない）|
| `confirmation_code` | `varchar(32)` | UNIQUE NOT NULL | Meta への応答・ステータス確認 URL 用 |
| `deleted_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

**Indexes**:
- `confirmation_code`（UNIQUE）
- `psid_hash`（INDEX、同一 PSID に対する重複削除リクエストの冪等性確認用）

**設計意図**:
- **平文 PSID を保存しない**：監査要件は「この PSID に対して削除処理を実行した事実」の証明であり、PSID そのものの特定は不要。漏洩時の影響を最小化するため一方向ハッシュで保存する。
- ハッシュ計算時にはアプリ固有の salt（SSM Parameter Store `/fumireply/review/deletion-log/hash-salt` で管理）を結合：`sha256(salt || psid)`。
- `confirmation_code` は漏洩しても PSID を逆引きできない（ランダム UUID）。
- status URL は現状通り認証なしで公開（Meta 仕様要件）。ただし返却するのは「Deleted」だけで、PSID や他の個人情報を含まない。

**保存期間**: **3 年間保持**。3 年経過後は自動削除（Phase 2 で cron バッチ実装、MVP では `audit-runbook.md` に手動 cleanup 手順を記載）。

**プライバシーポリシーへの記載**: 削除証跡を 3 年間 SHA-256 ハッシュ化形式で保持する旨を明示。

---

## Authentication（Supabase Auth）

### Supabase Auth ユーザー属性

| 属性 | 用途 |
|------|------|
| `id`（UUID）| Supabase Auth 内部の一意 ID。DB の `messages.sent_by_auth_uid` と突合 |
| `email` | ログイン ID |
| `email_confirmed_at` | MVP では作成時に確認済みとして登録（管理者作成）|
| `user_metadata.role` | （任意）`'operator' | 'reviewer'`。MVP 規模では権限分岐をほぼ使わないため UI 上の表示にのみ利用 |

MVP ではロールに基づく権限分岐を**実装しない**。ログインできるユーザーは inbox と送信機能を全て使える単純運用とする（運用者 1 名 + レビュワー 1 名規模のため）。Phase 2 でマルチオペレーター時にロールベース制御を導入する。

### 初期ユーザー（Supabase Dashboard / Admin API で作成）

| email | role | 備考 |
|-------|------|------|
| `operator@malbek.co.jp` | `operator` | Malbek 運用者 |
| `reviewer@malbek.co.jp` | `reviewer` | Meta レビュワー用（IP 制限・2FA なし） |

Supabase の Admin API（`auth.admin.createUser`）で作成し、初期パスワードは SSM Parameter Store にバックアップ保存（手順は `quickstart.md` 参照）。

### セッション方式

DB にセッションテーブルを**持たない**（ステートレス）。

- ログイン時：Supabase Auth が Access Token（1 時間） + Refresh Token（30 日、ローテーション）を発行
- アプリはそれらを HttpOnly Cookie にセット
- 毎リクエストで JWT 署名検証（Supabase JWKS をメモリキャッシュ）
- Access Token 期限切れ時は Refresh Token で再発行

詳細は [`contracts/admin-api.md`](./contracts/admin-api.md) の認証ミドルウェア節と R-002 を参照。

### RLS（Row Level Security）について

**MVP / Phase 2 を通じて採用しない**。理由：
- 運用者は自分（Malbek 1 社）のデータのみを扱うシングルテナント運用
- アプリ DB のテーブルは Drizzle + service role key（RLS バイパス）でアクセス
- マルチテナント化（Phase 3+）でテナント分離が必要になった時点で `tenants` テーブル + アプリ層の middleware で `tenant_id` をフィルタする方針

---

## Relationships

```
connected_pages   (1) ─── (*) conversations [page_id]
conversations     (1) ─── (*) messages      [conversation_id]
messages          (1) ─── (0..1) ai_drafts  [message_id, inbound のみ]
Supabase Auth User    ─── (*) messages      [sent_by_auth_uid, 論理参照のみ]
```

外部キー削除ポリシー：
- `conversations.page_id` → `connected_pages.id`：ON DELETE RESTRICT（削除はデータ削除コールバックでカスケード手動実行）
- `messages.conversation_id` → `conversations.id`：ON DELETE CASCADE（削除コールバックで会話を削除する際にメッセージも一括削除）
- `ai_drafts.message_id` → `messages.id`：ON DELETE CASCADE（メッセージ削除に追従）

---

## データ削除の扱い

Meta の Data Deletion Callback で削除対象 PSID が送られてきた場合：

1. `conversations` で `customer_psid = 対象 PSID` の行を取得
2. 当該 `conversation.id` に紐づく `messages` を DELETE（→ `ai_drafts` も CASCADE で削除）
3. `conversations` を DELETE
4. `deletion_log` に INSERT（監査ログ）
5. `confirmation_code` を Meta に URL + code として返す

SSM Parameter Store / connected_pages / Supabase Auth ユーザーは削除対象外。

---

## マイグレーション戦略

- `drizzle-kit generate` でマイグレーション SQL を生成
- PR レビューで目視確認後にマージ
- ローカル or CI から `drizzle-kit migrate` を Supabase に対して実行（接続文字列は SSM `/fumireply/review/supabase/db-url` 経由）
- Lambda 起動時の自動マイグレーションは実装しない（R-006）

初期マイグレーション（`0001_init.sql`）には以下を含める：
- 全 5 テーブル（`connected_pages`, `conversations`, `messages`, `ai_drafts`, `deletion_log`）の CREATE
- `connected_pages` の seed（Malbek のテスト FB ページ情報）。SSM キー名は以下の固定値を用いる：
  - `page_access_token_ssm_key = '/fumireply/review/meta/page-access-token'`
  - `webhook_verify_token_ssm_key = '/fumireply/review/meta/webhook-verify-token'`
  - `page_id` / `page_name` は運用時に確定させる（seed では placeholder、`npm run db:seed:review` 実行前に envs/review 用の実値に差し替える）

Supabase Auth ユーザーは Supabase Admin API（`quickstart.md` の手順）で管理し、DB マイグレーションには含めない。
