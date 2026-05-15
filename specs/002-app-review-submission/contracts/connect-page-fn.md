# Contract: Connect Page Server Functions

**Feature**: `002-app-review-submission`
**Date**: 2026-05-06
**実装方式**: TanStack Start `createServerFn`（既存パターン）
**配置**: `app/src/routes/(app)/onboarding/connect-page/-lib/`

クライアント（onboarding 画面）と Server fn の間の入出力契約。すべての server fn は **JWT 認証必須**で、`tenant_id` は JWT クレームから取得する（クライアントから渡さない）。

---

## 1. `exchangeAndListFn`

> **命名について**: 関数名は実装上 `exchangeAndListFn` のままだが、現行フローでは **Page 一覧取得（list）は行わない**。短期 user access token を長期化し、長期 user token をサーバ側で暗号化して httpOnly Cookie に退避するだけ。"AndList" は歴史的経緯による名残。

短期 user access token を受け取り、長期 user access token に交換し、暗号化して短命 httpOnly Cookie に保管する。Page 一覧はクライアントに返さない。

### Endpoint

`POST /_serverFn/exchangeAndList`（TanStack Start が自動ルーティング、URL 形式は実装詳細）

### Input Schema (Zod)

```typescript
import { z } from 'zod'

const ExchangeAndListInput = z.object({
  shortLivedUserToken: z.string().min(20).max(2000),
})
```

| フィールド | 制約 | 由来 |
|---|---|---|
| `shortLivedUserToken` | 20〜2000 文字の string | FB JS SDK の `FB.login`（`config_id` 指定の Login for Business）コールバックから取得 |

### Behavior

1. JWT から `tenant_id` を取得（`authMiddleware` 経由、既存パターン）
2. SSM（`env.META_APP_SECRET_SSM_KEY`）から App Secret 取得
3. `fb_exchange_token` を呼び出し → 長期 **user** access token 取得
4. 長期 user token を master key で AES-256-GCM 暗号化し、base64 化して httpOnly Cookie `fb_connect_session` に格納（`maxAge: 600`（10 分）, `httpOnly`, `sameSite: 'lax'`, `secure`（本番のみ）, `path: '/'`）
5. `/me/accounts` は**呼ばない**。Page 一覧も Page Access Token もクライアントに返さない
6. `{ ok: true }` のみ返す（後続 `connectPageFn` が Cookie から user token を読み戻す）

### Output Schema

#### Success

```typescript
const ExchangeAndListSuccess = z.object({
  ok: z.literal(true),
})
// 本体に pages 配列・トークンは一切含めない（Set-Cookie でサーバ側にのみ保持）
```

#### Failure

```typescript
const ExchangeAndListFailure = z.object({
  ok: z.literal(false),
  error: z.enum([
    'token_expired',         // FB error 190 (短期 token 失効)
    'permission_missing',    // FB error 200
    'rate_limited',          // FB error 4 (再試行尽きた)
    'meta_unavailable',      // 5xx / timeout
    'internal_error',        // 想定外エラー
  ]),
  message: z.string(),       // ユーザー向けエラーメッセージ
})
// 注: `/me/accounts` を呼ばないため `no_pages` は廃止
```

### Security Considerations

- **Page Access Token も長期 user token もブラウザに送出しない**。長期 user token はサーバ側で暗号化され、httpOnly Cookie でのみ往復する（JS から読めない／DevTools Network にも平文では出ない）。
- Cookie は暗号文（master key による AES-256-GCM）であり、`maxAge: 600` で短命。`connectPageFn` 成功時に即時失効（`maxAge: 0`）させる。
- レスポンス本体は server fn の TLS 経由で暗号化される（CloudFront → Lambda）。

### 設計判断：Page Access Token を server 側で保持（採用）

旧ドラフトでは「長期 Page Access Token をクライアントに返し、即座に `connectPageFn` へ再送する」案を採っていたが、**現行実装はこれを採用しない**。代わりにサーバ側保持方式（暗号化 httpOnly Cookie に長期 user token を退避し、Page Access Token はサーバ内でのみ取得・暗号化）を採用した。理由：(a) Page Access Token / user token がブラウザ JS・DevTools・拡張機能から一切観測できず、Meta App Review のセキュリティ観点で説明しやすい、(b) Cookie は SSR Lambda の各リクエストで自己完結して読めるため別途のサーバ状態（ステートフル化）は不要で冪等性は崩れない。

---

## 2. `connectPageFn`

ユーザーが入力した Page ID を、サーバ側で名称・Page Access Token に解決し、購読 + 暗号化保存する。

### Endpoint

`POST /_serverFn/connectPage`

### Input Schema

```typescript
const ConnectPageInput = z.object({
  pageId: z.string().regex(/^\d+$/).min(5).max(20),     // Facebook Page ID は数値文字列（ユーザーが手入力）
})
// pageName / pageAccessToken は受け取らない。
// クライアントは「どの Page を繋ぐか」だけを Page ID で指示する。
// 名称と Page Access Token はサーバが信頼できる長期 user token から導出する
// （クライアントが Page 名やトークンを詐称できない）。
```

### Behavior

1. JWT から `tenant_id` を取得（`authMiddleware`）
2. **逆 guard**: `withTenant` 内で active 行（`is_active = true`）が既にあれば即 `already_connected` を返す（spec FR-007）
3. httpOnly Cookie `fb_connect_session` を読み出す。無ければ `token_invalid`（セッション切れ、再接続を促す）
4. Cookie を master key で復号して長期 **user** token を復元
5. `fetchPageWithToken(pageId, longUserToken)` = `GET /v19.0/{pageId}?fields=id,name,access_token` を呼び、当該 Page の正式名称と長期 Page Access Token をサーバ側で取得（user が管理権限を持つ Page でなければ Graph がトークンを返さない＝なりすまし不可）
6. `POST /v19.0/{pageId}/subscribed_apps?subscribed_fields=messages,messaging_postbacks&access_token={pageAccessToken}` を呼び出し
7. `crypto.encrypt(pageAccessToken)` で AES-256-GCM 暗号化（既存 `app/src/server/services/crypto.ts`）
8. `withTenant(tenant_id, async (tx) => {...})` で：
   - 同一 `(tenant_id, page_id)` 行を SELECT。あれば UPDATE（再接続/トークン更新）、無ければプレーン INSERT
   - `page_id` のグローバル一意制約により別テナント所有 Page への INSERT は `23505` → `already_connected` に写像（クロステナント上書き防止）
9. Cookie `fb_connect_session` を `maxAge: 0` で失効させる
10. 成功レスポンスを返す（クライアントは `/inbox` に navigate）

### Output Schema

#### Success

```typescript
const ConnectPageSuccess = z.object({
  ok: z.literal(true),
  pageId: z.string(),         // 確認用（DB に保存された値）
  pageName: z.string(),
})
```

#### Failure

```typescript
const ConnectPageFailure = z.object({
  ok: z.literal(false),
  error: z.enum([
    'already_connected',          // 既に同テナントが active 接続済み or 別テナント所有 Page (pg 23505)
    'subscribe_failed',           // /subscribed_apps が失敗（FB error 190/200/803/etc.）
    'token_invalid',              // session cookie 欠落/失効、または fetchPageWithToken で page_not_found/token_expired
    'permission_missing',         // pages_show_list / pages_manage_metadata なし
    'webhook_url_failed',         // FB error 803 (Webhook URL 検証失敗)
    'encryption_failed',          // SSM 取得 or AES 失敗
    'db_failed',                  // 逆 guard SELECT 失敗 or INSERT/UPSERT 失敗
    'rate_limited',               // FB error 4 (再試行尽きた)
    'meta_unavailable',
    'internal_error',
  ]),
  message: z.string(),
})
```

### Idempotency

UPSERT 経路 + 購読 API の冪等性により、ユーザーが同じ Page を 2 回 connect しても結果は同じ。失敗時に部分的に DB に残ることはない（subscribe → encrypt → upsert の順なので、subscribe 失敗時は DB 書き込みなし）。

### Logging

```typescript
{
  event: "connect_page",
  tenant_id: string,
  page_id: string,
  status: "success" | "failure",
  step: "subscribe" | "encrypt" | "db" | undefined,  // failure 時にどの段階か
  error_code?: string,
  duration_ms: number,
}
```

**page_access_token はログに出さない**。

---

## 3. クライアント側のフロー

フロー状態は `index.tsx` が管理：`initial` → `session_ready` → `connecting` → `error`。

```typescript
// onboarding/connect-page/-components/ConnectFacebookButton.tsx 抜粋（疑似コード）
const handleConnect = async () => {
  const fb = await loadFbSdk(fbAppId)

  // 1. Facebook Login for Business で同意取得（4 権限は config_id の
  //    Login Configuration 側に束ねてある。scope 文字列は渡さない）
  const fbResponse = await new Promise<FBLoginResponse>((resolve) => {
    fb.login(resolve, {
      config_id: fbLoginConfigId,     // VITE_FB_LOGIN_CONFIG_ID
      auth_type: 'reauthenticate',    // 撮影時に毎回ダイアログを出す
    })
  })

  if (!fbResponse.authResponse) {
    onError('consent_denied')
    return
  }

  // 2. exchangeAndListFn 呼出（成功時は Set-Cookie のみ。本体に pages は無い）
  const result = await exchangeAndListFn({
    data: { shortLivedUserToken: fbResponse.authResponse.accessToken },
  })

  if (!result.ok) {
    onError(result.error)
    return
  }

  onSessionReady()   // → state 'session_ready' に遷移し PageIdInput を表示
}

// onboarding/connect-page/-components/PageIdInput.tsx 抜粋（疑似コード）
const handleSubmit = async (pageId: string) => {
  // クライアントは Page ID のみ送る。名称/トークンはサーバが解決する
  const connectResult = await connectPageFn({ data: { pageId } })

  if (!connectResult.ok) {
    onError(connectResult.error)
    return
  }

  router.navigate({ to: '/inbox' })
}
```

---

## 4. ガード server fn（既存ルートへの追記）

配置: `app/src/routes/(app)/onboarding/connect-page/-lib/check-connected-pages.fn.ts`

### `(app)/route.tsx` の `beforeLoad`（既存ファイルに追記）

擬似コード：

```typescript
beforeLoad: async ({ location }) => {
  if (location.pathname.startsWith('/onboarding')) return   // ループ防止
  const { count } = await checkConnectedPagesFn()           // 入力なし
  if (count === 0) {
    throw redirect({ to: '/onboarding/connect-page' })
  }
}
```

### `checkConnectedPagesFn`（server fn）

```typescript
// 入力なし。tenant_id は authMiddleware が JWT context から注入する
// （クライアントから tenantId を渡さない＝詐称不可）
// withTenant 内で:
//   SELECT count(*) FROM connected_pages
//   WHERE tenant_id = <jwt tenant> AND is_active = true
// 戻り値: { count: number }   ← count() を Number() に正規化
```

### `(app)/onboarding/connect-page/index.tsx` の逆 guard

```typescript
beforeLoad: async () => {
  const { count } = await checkConnectedPagesFn()
  if (count > 0) {
    throw redirect({ to: '/inbox' })
  }
}
```

---

## 5. テスト契約

> **実装ステータス注記**: 下表の `exchangeAndListFn` / `connectPageFn` / cross-tenant 統合テスト（tasks.md T035/T036/T039）は **未作成**。guard（T037/T038）はモックユニットテスト `app/src/test/routes/(app)/onboarding/connect-page/index.test.tsx` で部分カバー。E2E（T040）のみ実在。下表は実装すべき契約であって現状の到達点ではない。

| Test target | 入力 | 期待出力 |
|---|---|---|
| `exchangeAndListFn` happy path | 有効短期 token | `{ ok: true }` ＋ `Set-Cookie: fb_connect_session=...; HttpOnly` |
| `exchangeAndListFn` 短期 token 失効 | 失効 token（MSW で error 190） | `{ ok: false, error: 'token_expired' }`、Cookie 未設定 |
| `exchangeAndListFn` permission missing | MSW で error 200 | `{ ok: false, error: 'permission_missing' }` |
| `exchangeAndListFn` meta unavailable | MSW で 5xx 連発 | `{ ok: false, error: 'meta_unavailable' }` |
| `connectPageFn` happy path | `{ pageId }` ＋ 有効 session cookie（MSW で `GET /{pageId}` が name/token を返す） | DB に行が UPSERT、cookie 失効、`{ ok: true, pageId, pageName }` |
| `connectPageFn` session 欠落 | cookie 無しで `{ pageId }` | `{ ok: false, error: 'token_invalid' }`、DB 不変 |
| `connectPageFn` page not found | MSW で `GET /{pageId}` が error 100 | `{ ok: false, error: 'token_invalid' }`、DB 不変 |
| `connectPageFn` already_connected | 既に active 行あり | `{ ok: false, error: 'already_connected' }`、DB 不変 |
| `connectPageFn` subscribe failed | MSW で subscribed_apps が error 190 | `{ ok: false, error: 'subscribe_failed' }`、DB 不変 |
| `connectPageFn` cross-tenant 防御 | tenant A の JWT で tenant B 所有 pageId を接続試行 | グローバル unique 制約 23505 → `{ ok: false, error: 'already_connected' }`、tenant B 行不変 |
| `checkConnectedPagesFn` 0 件 | active 接続なしの tenant | `{ count: 0 }` |
| `checkConnectedPagesFn` 1 件 | active 接続済の tenant | `{ count: 1 }` |
