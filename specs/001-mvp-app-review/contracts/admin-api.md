# Contract: Admin API (Internal)

**Direction**: Admin UI (TanStack Start client) → Admin API (same TanStack Start server)
**Spec reference**: FR-002, FR-005, FR-006, FR-007, FR-008, FR-009, FR-018
**Implementation**: TanStack Start `createServerFn`
**Authentication**: Amazon Cognito User Pool + JWT in HttpOnly Cookie（DB セッションなし、R-002）

管理画面が呼び出す内部 API。全エンドポイント（`login` を除く）は JWT 認証ミドルウェアを通過する必須（FR-009）。未認証の場合は 401 で `/login` にリダイレクト。

---

## `serverFn: login({ email, password })`

### Input

```ts
{ email: string, password: string }
```

### Behavior

1. `@aws-sdk/client-cognito-identity-provider` の `InitiateAuthCommand` を `AuthFlow: 'USER_PASSWORD_AUTH'` で呼び出し
2. 成功時（`AuthenticationResult` が返る）：
   - `IdToken`、`RefreshToken` を HttpOnly Cookie にセット（`Secure`, `SameSite=Lax`）
   - JWT の `sub` / `email` / `cognito:groups` からユーザー情報を抽出してレスポンス返却
3. 失敗時（`NotAuthorizedException` / `UserNotFoundException`）：401 + 汎用エラーメッセージ（"Invalid credentials"。Cognito の詳細エラーは**クライアントに露出しない**）
4. `NEW_PASSWORD_REQUIRED` チャレンジが返った場合（初回ログイン等）：専用のパスワード変更画面にリダイレクトするためのレスポンス `{ ok: false, error: 'new_password_required', session: <Cognito Session 文字列> }` を返す

### Output

```ts
// 成功
{
  ok: true,
  user: {
    sub: string          // Cognito 一意 ID
    email: string
    role: 'operator' | 'reviewer'  // cognito:groups から派生
  }
}

// 失敗
{ ok: false, error: 'invalid_credentials' }
{ ok: false, error: 'new_password_required', session: string }
```

### Cookie

| 名前 | 値 | 属性 | Max-Age |
|------|-----|-----|---------|
| `id_token` | Cognito ID Token（JWT）| HttpOnly, Secure, SameSite=Lax, Path=/ | 3600（1 時間）|
| `refresh_token` | Cognito Refresh Token | HttpOnly, Secure, SameSite=Lax, Path=/ | 2592000（30 日）|

### Rate limiting

Cognito User Pool 側でアカウントロック設定（5 回失敗で 60 分ロック、デフォルト設定）。アプリ側では追加実装せず、Cognito の `NotAuthorizedException` に `TooManyFailedAttemptsException` メッセージが含まれた場合は別エラーコード `too_many_attempts` を返す。

---

## `serverFn: logout()`

### Behavior

1. Cookie から `refresh_token` を取得
2. Cognito `GlobalSignOutCommand` を呼び出し、Refresh Token を Cognito 側で無効化
3. `id_token`、`refresh_token` Cookie を削除（`Max-Age=0`）

### Output

```ts
{ ok: true }
```

---

## `serverFn: refreshSession()` *(内部使用、明示的に呼び出す必要なし)*

ID Token 期限切れを検知した認証ミドルウェアが内部的に呼び出すフロー。

### Behavior

1. Cookie から `refresh_token` を取得
2. Cognito `InitiateAuthCommand` を `AuthFlow: 'REFRESH_TOKEN_AUTH'` で呼び出し
3. 新 `IdToken` を取得（`RefreshToken` は再発行されないことが多いため、既存 Cookie を維持）
4. 新 `IdToken` を Cookie に上書き
5. Refresh Token 自体が失効していた場合（`NotAuthorizedException`）はログアウト扱い → `/login` にリダイレクト

---

## `serverFn: listConversations()`

受信一覧表示用。

### Input

```ts
{ limit?: number = 50, before?: string /* ISO timestamp */ }
```

### Behavior

1. JWT 認証ミドルウェア通過（下記「認証ミドルウェア」節参照）
2. `conversations` を `last_message_at DESC` で取得
3. 各会話の最新メッセージ 1 件を join で同時取得

### Output

```ts
{
  conversations: Array<{
    id: string
    customer_psid: string
    customer_name: string | null
    last_message_at: string  // ISO
    last_inbound_at: string | null
    unread_count: number
    last_message_preview: string  // 最新メッセージ本文の先頭 100 文字
    last_message_direction: 'inbound' | 'outbound'
    within_24h_window: boolean  // 現在時刻 - last_inbound_at < 24h
  }>
}
```

---

## `serverFn: getConversation({ id })`

スレッド詳細表示用。

### Input

```ts
{ id: string }  // conversation.id
```

### Behavior

1. JWT 認証ミドルウェア通過（下記「認証ミドルウェア」節参照）
2. `conversations` + `messages`（時系列昇順）を取得
3. `unread_count` を 0 にリセット（閲覧した扱い）

### Output

```ts
{
  conversation: {
    id: string
    customer_psid: string
    customer_name: string | null
    last_inbound_at: string | null
    within_24h_window: boolean
    hours_remaining_in_window: number | null
  }
  messages: Array<{
    id: string
    direction: 'inbound' | 'outbound'
    body: string
    message_type: 'text' | 'sticker' | 'image' | 'other'
    timestamp: string  // ISO
    send_status: 'sent' | 'failed' | 'pending' | null
    send_error: string | null
  }>
}
```

---

## `serverFn: sendReply({ conversationId, body })`

返信送信用。FR-005 〜 FR-008 の中核。

### Input

```ts
{ conversationId: string, body: string }
```

### Behavior

1. JWT 認証確認（`cognito:groups` に `operators` または `reviewers` が含まれることを確認）
2. `conversations` から取得、`last_inbound_at` が 24h 以内か確認（超過なら `outside_window` エラーを返す）
3. `messages` に `send_status='pending'`, `sent_by_cognito_sub=JWT.sub` で INSERT
4. SSM から Page Access Token 取得（キャッシュ活用）
5. Meta Send API を呼び出し（[meta-send-api.md](./meta-send-api.md) 準拠）
6. 成功時：`messages` を UPDATE（`send_status='sent'`, `meta_message_id`）、`conversations.last_message_at` 更新
7. 失敗時：`messages` を UPDATE（`send_status='failed'`, `send_error`）、エラーレスポンス返却

### Output

```ts
// 成功
{ ok: true, message: { id, body, timestamp, send_status: 'sent' } }

// 失敗
{
  ok: false,
  error: 'outside_window' | 'token_expired' | 'meta_error' | 'validation_failed',
  details?: string
}
```

**時間制約**: 5 秒以内にレスポンスを返す（FR-006、SC-004）。5xx のリトライ含めても 10 秒以内に決着させる。

---

## `serverFn: getPageStatus()`

Page Access Token の有効性確認用（FR-018）。管理画面ヘッダーで定期的（5 分ごと）に呼び出す。

### Input

なし

### Behavior

1. JWT 認証ミドルウェア通過（下記「認証ミドルウェア」節参照）
2. Meta Graph API `GET /me?fields=id,name` を Page Access Token で呼び出し（軽量な疎通確認）
3. 成功なら有効、401 なら失効と判定

### Output

```ts
{
  page_id: string
  page_name: string
  token_valid: boolean
  token_last_checked_at: string
}
```

**Rate limit 対策**: Meta の無料枠を圧迫しないよう、サーバー側で 5 分キャッシュする。

---

## 認証ミドルウェア

全 `serverFn`（`login` 除く）は以下のミドルウェアを通過する。JWT をステートレスに検証するため DB 参照なし。

```ts
import { CognitoJwtVerifier } from 'aws-jwt-verify'

// Lambda コンテナ内で 1 回だけ初期化（JWKS はモジュール内で自動キャッシュ）
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID!,
  tokenUse: 'id',
  clientId: process.env.COGNITO_APP_CLIENT_ID!,
})

middleware: async ({ request }) => {
  const idToken = getCookie(request, 'id_token')
  if (!idToken) throw redirect({ to: '/login' })

  try {
    const payload = await verifier.verify(idToken)
    return {
      user: {
        sub: payload.sub,
        email: payload.email,
        groups: payload['cognito:groups'] ?? [],
      },
    }
  } catch (err) {
    // ID Token 期限切れなら Refresh Token で再発行を試みる
    if (err instanceof JwtExpiredError) {
      const newIdToken = await refreshSession(request)
      if (newIdToken) {
        // 新 Cookie をセットした上で検証をリトライ
        const payload = await verifier.verify(newIdToken)
        return { user: { sub: payload.sub, email: payload.email, groups: payload['cognito:groups'] ?? [] } }
      }
    }
    throw redirect({ to: '/login' })
  }
}
```

セッション切れは `/login` へリダイレクト + 元 URL を `returnTo` クエリで保持。

---

## テスト

| Test | Type | Coverage |
|------|------|----------|
| 全 serverFn に認証が必要 | integration | 未ログインで呼び出して 401/リダイレクト |
| login 正常系 | integration | Cognito `InitiateAuth` モック → Cookie 発行を確認 |
| login 異常系（不正資格情報）| integration | `NotAuthorizedException` モック → 401 |
| login 異常系（ロック）| integration | `TooManyFailedAttemptsException` → `too_many_attempts` エラー |
| logout | integration | `GlobalSignOut` 呼び出し + Cookie 削除を確認 |
| JWT 検証（ID Token 有効）| unit | `aws-jwt-verify` の verify 成功 → user 情報取得 |
| JWT 検証（ID Token 期限切れ）| integration | `JwtExpiredError` → refreshSession 呼び出し → 新 Token で再検証 |
| JWT 検証（Refresh Token も失効）| integration | 双方失効 → `/login` リダイレクト |
| listConversations 並び順 | integration | last_message_at DESC、fixture で確認 |
| getConversation unread リセット | integration | 呼び出し後に unread_count=0 |
| sendReply 成功 | integration | Meta API モック → DB に `sent_by_cognito_sub` 付きで sent 記録 |
| sendReply 24h 超過 | unit | API 呼び出し前にエラー |
| sendReply トークン失効 | integration | モック 400 → failed で記録 + エラーメッセージ |
| getPageStatus トークン失効検知 | integration | モック 401 → token_valid: false |
