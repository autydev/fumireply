# Contract: Facebook Graph API（Page Connection 関連）

**Feature**: `002-app-review-submission`
**Date**: 2026-05-06
**API バージョン**: `v19.0`（001 と統一）
**呼び出し主体**: SSR Lambda 上の server fn（`createServerFn`）
**HTTP クライアント**: グローバル `fetch` + `AbortSignal.timeout(10000)`

本機能で外部に発信するすべての Graph API 呼び出しの契約を定義する。すべて server fn 内部で完結し、レスポンスをクライアントに**生の Graph レスポンスのまま返さない**（必要なフィールドのみ抽出する）。

---

## 1. `GET /v19.0/oauth/access_token` — fb_exchange_token

短期 user access token を長期 user access token に交換する。

### Request

```http
GET /v19.0/oauth/access_token
    ?grant_type=fb_exchange_token
    &client_id={APP_ID}
    &client_secret={APP_SECRET}
    &fb_exchange_token={SHORT_LIVED_USER_TOKEN}
Host: graph.facebook.com
```

| パラメータ | 値 | 取得元 |
|---|---|---|
| `grant_type` | `fb_exchange_token`（固定） | — |
| `client_id` | Facebook App ID | env `META_APP_ID`（client から渡るため埋め込み可） |
| `client_secret` | Facebook App Secret | SSM `/fumireply/review/meta/app-secret` (server fn 内で取得) |
| `fb_exchange_token` | 短期 user access token | client から POST、Zod でフォーマット検証 |

### Success Response (200)

```json
{
  "access_token": "EAAxxx...",
  "token_type": "bearer",
  "expires_in": 5183999
}
```

| フィールド | 抽出 |
|---|---|
| `access_token` | これが長期 user access token。暗号化して httpOnly Cookie に退避し、次の単一 Page 取得（`GET /{page-id}`）で使用 |
| `expires_in` | 約 60 日（実用上は再交換不要だが、ログに残す） |

### Error Response (4xx)

```json
{
  "error": {
    "message": "Invalid OAuth access token.",
    "type": "OAuthException",
    "code": 190,
    "fbtrace_id": "xxx"
  }
}
```

| エラーコード | 意味 | server fn の挙動 |
|---|---|---|
| 190 | 短期トークンが既に失効、または無効 | UI に「権限が失効しました。再接続してください」を返し、再 Login を促す |
| 100 | パラメータ不正 | UI に「内部エラー」、CloudWatch にスタックトレース |
| 4 | レート制限 | 指数バックオフ 3 回まで再試行、最終失敗時は UI に「しばらくお待ちください」 |

### Logging

```typescript
{
  event: "fb_exchange_token",
  status: "success" | "failure",
  expires_in: number,
  error_code?: number,
  fbtrace_id?: string,
  duration_ms: number
}
```

**App Secret はログに出さない**。

---

## 2. `GET /v19.0/{page-id}` — 単一 Page 取得（`fetchPageWithToken`）

長期 user access token と、**ユーザーが手入力した Page ID** を使い、その 1 ページの正式名称と長期 Page Access Token をサーバ側で取得する。

> **重要（App Review 説明への影響）**: 現行フローは `/me/accounts` による Page 一覧列挙を行わない。`pages_show_list` は「ユーザーが管理する Page の `access_token` フィールドを Graph 経由で取得できる」ために依然必要だが、その使われ方は「一覧を列挙してユーザーに選ばせる」ではなく「ユーザーが指定した 1 ページのトークンをサーバ側で解決する」である。use-case-description.md の `pages_show_list` 説明文はこの実態に合わせること。`listPages`（`/me/accounts`）ヘルパは `facebook.ts` に残置されているが connect フローからは**未使用**（将来の複数ページ対応用）。

### Request

```http
GET /v19.0/{PAGE_ID}?access_token={LONG_LIVED_USER_TOKEN}&fields=id,name,access_token
Host: graph.facebook.com
```

| パラメータ | 値 |
|---|---|
| `{PAGE_ID}` | ユーザーが入力欄に手入力した数値 Page ID（Zod `^\d{5,20}$`） |
| `access_token` | fb_exchange_token で得た長期 user access token（httpOnly Cookie から復号） |
| `fields` | `id,name,access_token`（`access_token` は当該 Page の Page Access Token） |

### Success Response (200)

```json
{
  "id": "1234567890",
  "name": "Malbek Test Page",
  "access_token": "EAAxxx...(Page Access Token)..."
}
```

| フィールド | 抽出 |
|---|---|
| `id` | Page ID（DB 保存対象） |
| `name` | Page 表示名（サーバが解決した正式名称。DB 保存対象） |
| `access_token` | 長期 Page Access Token（暗号化して DB 保存対象） |

`access_token` フィールドが返らない場合（ユーザーが当該 Page の管理権限を持たない等）は `permission_missing`（code 200 相当）として扱う。

### Error Response

| エラーコード | 意味 | server fn の挙動 |
|---|---|---|
| 100 | 指定 Page ID が存在しない / ユーザーがアクセスできない | `page_not_found` → UI は `token_invalid`「Page が見つからないかアクセス権がありません」、再入力を促す |
| 190 | 長期トークンが失効 | `token_expired` → UI は再 Login 促し（fb_exchange_token から再実行） |
| 200 | 権限不足（pages_show_list 未同意 / 当該 Page 非管理） | `permission_missing` → UI に「pages_show_list 権限が必要です」、再 Login |
| 4 | レート制限 | 指数バックオフ 3 回、最終失敗時 `rate_limited` |

### Logging

```typescript
{
  event: "fetch_page",
  status: "success" | "failure",
  page_id: string,
  error_code?: number,
  duration_ms: number
}
```

**Page Access Token / long user token はログに出さない**。

---

## 3. `POST /v19.0/{page-id}/subscribed_apps` — Webhook 購読

選択された Page で本アプリが Messenger Webhook を受信できるよう購読する。

### Request

```http
POST /v19.0/{PAGE_ID}/subscribed_apps
    ?subscribed_fields=messages,messaging_postbacks
    &access_token={PAGE_ACCESS_TOKEN}
Host: graph.facebook.com
```

| パラメータ | 値 |
|---|---|
| `subscribed_fields` | `messages,messaging_postbacks`（カンマ区切り、001 と統一） |
| `access_token` | Page Access Token（`fetchPageWithToken` (`GET /{page-id}`) のレスポンスから取得） |

### Success Response (200)

```json
{ "success": true }
```

冪等：既に購読済みの Page でも `success: true` が返る。

### Error Response

| エラーコード | 意味 | server fn の挙動 |
|---|---|---|
| 190 | Page Access Token 無効 | UI に「再接続が必要です」、サブ手順から再実行 |
| 200 | 権限不足（pages_manage_metadata が同意されていない） | UI に「pages_manage_metadata 権限が必要です」、再 Login |
| 100 | subscribed_fields の値不正 | UI に「内部エラー」、CloudWatch にバグ通知 |
| 803 | Webhook URL の HTTPS 検証失敗 | UI に「Webhook URL が応答していません。運用に連絡してください」 |

### Logging

```typescript
{
  event: "subscribe_apps",
  status: "success" | "failure",
  page_id: string,
  fields: string[],
  error_code?: number,
  duration_ms: number
}
```

---

## 4. 共通仕様

### タイムアウト

すべての呼び出しに `AbortSignal.timeout(10000)` を付ける（10 秒）。リトライは指数バックオフ：1s, 2s, 4s で最大 3 回。リトライは 5xx と HTTP タイムアウト時のみ実施し、4xx はリトライしない。

### App Secret 取扱い

`/fumireply/review/meta/app-secret` から取得した App Secret は：
- メモリ上のみで保持（プロセス再起動で破棄）
- **絶対にクライアントに返さない**
- **絶対にログに出さない**
- Page Access Token と組み合わせて `appsecret_proof` を生成する **ことはしない**（本 MVP ではプロトコル簡素化）

### Graph API バージョン

`v19.0` 固定。Meta が新バージョンを推奨してきても本 feature ブランチではアップデートしない。Graph API バージョンアップは別 spec で扱う。

### 失敗時の DB 影響範囲

server fn 全体を `withTenant(tenant_id, async (tx) => {...})` で囲み、**Webhook 購読が成功してから DB UPSERT を実行**する。途中で失敗した場合は DB 書き込みなし（クライアントにエラー返却）。

---

## 5. 契約のテスト方針

> **実装ステータス注記**: MSW ハンドラ `app/src/test/msw/facebook-handlers.ts` は fb_exchange_token / `/me/accounts` / subscribed_apps をモック済みだが、現行フローが使う `GET /v19.0/{page-id}`（`fetchPageWithToken`）のハンドラは**未追加**。下表の `{page-id}` 行と、tasks.md T035/T036 はこのハンドラ追加が前提（tasks.md T017 STATUS 注記参照）。

| 契約 | テスト方法 |
|---|---|
| fb_exchange_token | MSW で `https://graph.facebook.com/v19.0/oauth/access_token*` を mock し、success / 190 / 100 / 4 の各レスポンスを返して server fn の挙動を確認 |
| `GET /{page-id}`（fetchPageWithToken） | MSW で `https://graph.facebook.com/v19.0/:pageId` を mock し、success（id/name/access_token）/ access_token 欠落 / 100 / 190 / 200 / 4 の各パターン |
| subscribed_apps | 同上で success / 190 / 200 / 803 の各パターン |
| 統合 | exchange → (cookie) → fetchPage → subscribe を連続 mock し、server fn が全段階を順序通り呼ぶことを確認 |
