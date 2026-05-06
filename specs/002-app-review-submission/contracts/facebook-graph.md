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
| `access_token` | これが長期 user access token、次の `/me/accounts` 呼出で使用 |
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

## 2. `GET /v19.0/me/accounts` — Page 一覧取得

長期 user access token を使ってユーザーが管理する Page の一覧を取得する。

### Request

```http
GET /v19.0/me/accounts?access_token={LONG_LIVED_USER_TOKEN}&fields=id,name,access_token
Host: graph.facebook.com
```

| パラメータ | 値 |
|---|---|
| `access_token` | fb_exchange_token で得た長期 user access token |
| `fields` | `id,name,access_token`（`access_token` は Page Access Token） |

### Success Response (200)

```json
{
  "data": [
    {
      "id": "1234567890",
      "name": "Malbek Test Page",
      "access_token": "EAAxxx...(Page Access Token)..."
    }
  ],
  "paging": {
    "cursors": { "before": "...", "after": "..." },
    "next": "...(URL)..."
  }
}
```

| フィールド | 抽出 |
|---|---|
| `data[].id` | Page ID（DB 保存対象） |
| `data[].name` | Page 表示名（DB 保存対象 + UI に表示） |
| `data[].access_token` | 長期 Page Access Token（暗号化して DB 保存対象） |
| `paging.next` | 複数ページがある場合の次ページ URL（後述） |

### ページネーション

通常 1 user が 25 Page 未満のため 1 ページで完結するが、`paging.next` が存在する場合は再帰的に追加取得する。**MVP では 50 件で打ち切り**（それ以上は UI で「絞り込み検索を実装してください」とエラー）。

### Empty Response

`data: []` の場合、ユーザーが Page を 1 つも管理していない。UI に「Facebook Page がありません。Facebook for Business で Page を作成してください」と案内し、再試行不可の状態にする。

### Error Response

| エラーコード | 意味 | server fn の挙動 |
|---|---|---|
| 190 | 長期トークンが失効 | UI に再 Login 促し（fb_exchange_token から再実行） |
| 200 | 権限不足（pages_show_list が同意されていない） | UI に「pages_show_list 権限が必要です」、再 Login 促し |
| 4 | レート制限 | 指数バックオフ |

### Logging

```typescript
{
  event: "me_accounts",
  status: "success" | "failure",
  page_count: number,
  has_next_page: boolean,
  error_code?: number,
  duration_ms: number
}
```

**Page Access Token はログに出さない**。

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
| `access_token` | Page Access Token（/me/accounts のレスポンスから取得） |

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

| 契約 | テスト方法 |
|---|---|
| fb_exchange_token | MSW で `https://graph.facebook.com/v19.0/oauth/access_token*` を mock し、success / 190 / 100 / 4 の各レスポンスを返して server fn の挙動を確認 |
| /me/accounts | 同上（MSW）で 0 件 / 1 件 / 25 件 / paging next 付きの各パターン |
| subscribed_apps | 同上で success / 190 / 200 / 803 の各パターン |
| 統合 | 上記 3 つを連続して mock し、server fn が全段階を順序通り呼ぶことを確認 |
