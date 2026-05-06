# Contract: Connect Page Server Functions

**Feature**: `002-app-review-submission`
**Date**: 2026-05-06
**実装方式**: TanStack Start `createServerFn`（既存パターン）
**配置**: `app/src/routes/(app)/onboarding/connect-page/-lib/`

クライアント（onboarding 画面）と Server fn の間の入出力契約。すべての server fn は **JWT 認証必須**で、`tenant_id` は JWT クレームから取得する（クライアントから渡さない）。

---

## 1. `exchangeAndListFn`

短期 user access token を受け取り、長期化と Page 一覧取得をまとめて実行する。

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
| `shortLivedUserToken` | 20〜2000 文字の string | FB JS SDK の `FB.login` コールバックから取得 |

### Behavior

1. JWT から `tenant_id` を取得（middleware 経由、既存パターン）
2. SSM `/fumireply/review/meta/app-secret` から App Secret 取得
3. `fb_exchange_token` を呼び出し → 長期 user access token 取得
4. `/me/accounts` を呼び出し → Pages 一覧取得
5. レスポンスを構造化して返す（**Page Access Token も含めて返す**が後続 fn で受け取り直すためサーバ-クライアント間 1 度きりの送信）

### Output Schema

#### Success

```typescript
const ExchangeAndListSuccess = z.object({
  ok: z.literal(true),
  pages: z.array(
    z.object({
      id: z.string(),                  // Page ID
      name: z.string(),                // Page name
      pageAccessToken: z.string(),     // 長期 Page Access Token（次の fn で使う）
    })
  ).max(50),
})
```

#### Failure

```typescript
const ExchangeAndListFailure = z.object({
  ok: z.literal(false),
  error: z.enum([
    'token_expired',         // FB error 190 (短期 token 失効)
    'permission_missing',    // FB error 200 (pages_show_list なし)
    'no_pages',              // /me/accounts が空配列
    'rate_limited',          // FB error 4 (再試行尽きた)
    'meta_unavailable',      // 5xx / timeout
    'internal_error',        // 想定外エラー
  ]),
  message: z.string(),       // ユーザー向けエラーメッセージ（i18n キー or 完成文）
})
```

### Security Considerations

- 長期 Page Access Token を**クライアントに返す**ことになる：これは Meta の OAuth flow で許容されている範囲（Facebook JS SDK のレスポンスにも含まれる）。クライアントは即座に `connectPageFn` に再送するため、メモリ上の保持時間は数秒。
- レスポンス本体は server fn の TLS 経由で暗号化される（CloudFront → Lambda）。
- ブラウザの DevTools で Network タブを開けば見えるが、これは Facebook JS SDK でも同じ。

### 代替案：Page Access Token を server 側で保持

サーバー側でセッションに紐付けて一時保持し、クライアントには Page ID のみ返す案は採用しない。理由：(a) ステートフル処理が必要で SSR Lambda の冪等性が崩れる、(b) 実装複雑化に対するメリットが小さい（Token は 5 秒で再投入される）。

---

## 2. `connectPageFn`

ユーザーが選択した Page を購読 + 暗号化保存する。

### Endpoint

`POST /_serverFn/connectPage`

### Input Schema

```typescript
const ConnectPageInput = z.object({
  pageId: z.string().regex(/^\d+$/).min(5).max(20),     // Facebook Page ID は数値文字列
  pageName: z.string().min(1).max(200),
  pageAccessToken: z.string().min(20).max(2000),         // exchangeAndListFn のレスポンスから
})
```

### Behavior

1. JWT から `tenant_id` を取得
2. **逆 guard**: 既に `connected_pages` に行があれば即座に `already_connected` エラーを返す（spec の R-006 / FR-007 通り）
3. `POST /v19.0/{pageId}/subscribed_apps?subscribed_fields=messages,messaging_postbacks&access_token={pageAccessToken}` を呼び出し
4. `crypto.encrypt(pageAccessToken)` で AES-256-GCM 暗号化（既存 `app/src/server/services/crypto.ts`）
5. `withTenant(tenant_id, async (tx) => {...})` で：
   - INSERT INTO connected_pages (tenant_id, page_id, page_name, page_access_token_encrypted, webhook_verify_token_ssm_key) VALUES (...)
   - ON CONFLICT (tenant_id) DO UPDATE SET page_id, page_name, page_access_token_encrypted, updated_at
6. 成功レスポンスを返す（クライアントは `/inbox` に navigate）

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
    'already_connected',          // 既に同テナントが別 Page で接続済み
    'subscribe_failed',           // /subscribed_apps が失敗（FB error 190/200/803/etc.）
    'token_invalid',              // Page Access Token が無効
    'permission_missing',         // pages_manage_metadata なし
    'webhook_url_failed',         // FB error 803 (Webhook URL 検証失敗)
    'encryption_failed',          // SSM 取得 or AES 失敗
    'db_failed',                  // INSERT/UPSERT 失敗
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

```typescript
// onboarding/connect-page/-components/ConnectFacebookButton.tsx 抜粋（疑似コード）
const handleConnect = async () => {
  // 1. FB SDK で同意取得
  const fbResponse = await new Promise<FBLoginResponse>((resolve, reject) => {
    FB.login(resolve, {
      scope: 'pages_show_list,pages_manage_metadata,pages_read_engagement,pages_messaging',
      auth_type: 'reauthenticate',  // 撮影時に毎回ダイアログを出す
    })
  })

  if (!fbResponse.authResponse) {
    setError('consent_denied')
    return
  }

  // 2. exchangeAndListFn 呼出
  const listResult = await exchangeAndListFn({
    data: { shortLivedUserToken: fbResponse.authResponse.accessToken },
  })

  if (!listResult.ok) {
    setError(listResult.error)
    return
  }

  setPages(listResult.pages)  // PageList コンポーネントで表示
}

// PageList の onSelect ハンドラ
const handleSelect = async (page: { id: string; name: string; pageAccessToken: string }) => {
  const connectResult = await connectPageFn({
    data: {
      pageId: page.id,
      pageName: page.name,
      pageAccessToken: page.pageAccessToken,
    },
  })

  if (!connectResult.ok) {
    setError(connectResult.error)
    return
  }

  navigate({ to: '/inbox' })
}
```

---

## 4. ガード server fn（既存ルートへの追記）

### `(app)/route.tsx` の `beforeLoad`（既存ファイルに追記）

擬似コード：

```typescript
beforeLoad: async ({ context }) => {
  const { tenantId } = context.session
  const count = await checkConnectedPagesFn({ data: { tenantId } })
  if (count === 0) {
    throw redirect({ to: '/onboarding/connect-page' })
  }
}
```

### `checkConnectedPagesFn`（新規 server fn）

```typescript
const Input = z.object({
  tenantId: z.string().uuid(),
})

const Output = z.object({
  count: z.number().int().min(0),
})

// withTenant 内で SELECT count(*) FROM connected_pages
```

### `(app)/onboarding/connect-page/index.tsx` の逆 guard

```typescript
beforeLoad: async ({ context }) => {
  const count = await checkConnectedPagesFn({ data: { tenantId: context.session.tenantId } })
  if (count > 0) {
    throw redirect({ to: '/inbox' })
  }
}
```

---

## 5. テスト契約

| Test target | 入力 | 期待出力 |
|---|---|---|
| `exchangeAndListFn` happy path | 有効短期 token | `{ ok: true, pages: [{ id, name, pageAccessToken }] }` |
| `exchangeAndListFn` 短期 token 失効 | 失効 token（MSW で error 190） | `{ ok: false, error: 'token_expired' }` |
| `exchangeAndListFn` permission missing | MSW で error 200 | `{ ok: false, error: 'permission_missing' }` |
| `exchangeAndListFn` no pages | MSW で `data: []` | `{ ok: false, error: 'no_pages' }` |
| `connectPageFn` happy path | 有効入力 | DB に行が UPSERT される、`{ ok: true, pageId, pageName }` |
| `connectPageFn` already_connected | 既に DB に行あり | `{ ok: false, error: 'already_connected' }`、DB 不変 |
| `connectPageFn` subscribe failed | MSW で subscribed_apps が error 190 | `{ ok: false, error: 'subscribe_failed' }`、DB 不変 |
| `connectPageFn` cross-tenant 防御 | tenant A の JWT で tenant B 向け接続を試みる | RLS により DB 書き込み拒否、`{ ok: false, error: 'db_failed' }` |
| `checkConnectedPagesFn` 0 件 | 接続なしの tenant | `{ count: 0 }` |
| `checkConnectedPagesFn` 1 件 | 接続済の tenant | `{ count: 1 }` |
