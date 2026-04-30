# Contract: Admin API (Internal)

**Direction**: Admin UI (TanStack Start client) → Admin API (same TanStack Start server)
**Spec reference**: FR-002, FR-005, FR-006, FR-007, FR-008, FR-009, FR-018, FR-022〜FR-026
**Implementation**: TanStack Start `createServerFn`
**Authentication**: Supabase Auth + JWT in HttpOnly Cookie（DB セッションなし、R-002）

管理画面が呼び出す内部 API。全エンドポイント（`login` を除く）は JWT 認証ミドルウェアを通過する必須（FR-009）。未認証の場合は 401 で `/login` にリダイレクト。

**呼び出し規約**: すべて TanStack Start の `createServerFn` として実装する。クライアント（ブラウザ）からは型付き RPC として呼び出され、内部的に HTTP POST に変換される。**外部の curl 等から直接叩く用途は想定しない**（疎通確認はブラウザで UI 経由で行う）。外部連携（Meta Webhook 等）は別 Lambda の HTTP ルートとして定義する（`contracts/meta-webhook.md`、`contracts/data-deletion-callback.md`）。

**クライアント側の呼び出し方法**（実装者向け）:

```ts
// app/src/routes/(auth)/login/-lib/login.fn.ts
import { createServerFn } from '@tanstack/react-start'
export const loginFn = createServerFn({ method: 'POST' })
  .validator((input: { email: string; password: string }) => input)
  .handler(async ({ data }) => { /* ... */ })

// app/src/routes/(auth)/login/index.tsx — クライアントから呼び出す
import { loginFn } from './-lib/login.fn'
const result = await loginFn({ data: { email, password } })
```

---

## `serverFn: login({ email, password })`

### Input

```ts
{ email: string, password: string }
```

### Behavior

1. `@supabase/supabase-js` の `auth.signInWithPassword({ email, password })` を呼ぶ
2. 成功時（`session` が返る）：
   - `session.access_token`、`session.refresh_token` を HttpOnly Cookie にセット（`Secure`, `SameSite=Lax`）
   - JWT の `sub` / `email` / `user_metadata.role` からユーザー情報を抽出してレスポンス返却
3. 失敗時（`AuthError` invalid_grant 系）：401 + 汎用エラーメッセージ（"Invalid credentials"。Supabase の詳細エラーは**クライアントに露出しない**）
4. ユーザーが `banned_until` 未来日で無効化されている場合：401 + 同じ汎用メッセージ（情報漏洩を避ける）

### Output

```ts
// 成功
{
  ok: true,
  user: {
    id: string          // Supabase Auth UUID（auth.users.id）
    email: string
    role: 'operator' | 'reviewer' | null  // user_metadata.role から派生
  }
}

// 失敗
{ ok: false, error: 'invalid_credentials' }
```

### Cookie

| 名前 | 値 | 属性 | Max-Age |
|------|-----|-----|---------|
| `sb-access-token` | Supabase Access Token（JWT）| HttpOnly, Secure, SameSite=Lax, Path=/ | 3600（1 時間）|
| `sb-refresh-token` | Supabase Refresh Token | HttpOnly, Secure, SameSite=Lax, Path=/ | 2592000（30 日）|

### Rate limiting

Supabase Auth 側でレート制限がかかる（IP ベース、デフォルト 30 req/h）。MVP ではアプリ側で追加実装しない。

---

## `serverFn: logout()`

### Behavior

1. Cookie から `sb-refresh-token` を取得
2. Supabase の `auth.signOut(refreshToken)`（Admin API or scoped）を呼んで Refresh Token を無効化
3. `sb-access-token`、`sb-refresh-token` Cookie を削除（`Max-Age=0`）

### Output

```ts
{ ok: true }
```

---

## `serverFn: refreshSession()` *(内部使用、明示的に呼び出す必要なし)*

Access Token 期限切れを検知した認証ミドルウェアが内部的に呼び出すフロー。

### Behavior

1. Cookie から `sb-refresh-token` を取得
2. Supabase の `auth.refreshSession({ refresh_token })` を呼ぶ
3. 新しい Access Token + Refresh Token（Supabase はローテーションする）を Cookie に上書き
4. Refresh Token 自体が失効していた場合（`AuthError`）はログアウト扱い → `/login` にリダイレクト

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

スレッド詳細表示用。AI 下書きを含む。

### Input

```ts
{ id: string }  // conversation.id
```

### Behavior

1. JWT 認証ミドルウェア通過
2. `conversations` + `messages`（時系列昇順）を取得
3. 各 inbound `messages` に対応する `ai_drafts` を LEFT JOIN で取得（ない場合は null）
4. 最新の inbound メッセージに紐づく `ai_drafts.body`（`status='ready'` の場合）を `latest_draft` として別途返却（ReplyForm の初期値用）
5. `unread_count` を 0 にリセット（閲覧した扱い）

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
    ai_draft: {                 // inbound のみ。生成中・失敗・テキスト以外メッセージは null
      status: 'pending' | 'ready' | 'failed'
      body: string | null
      model: string | null
    } | null
  }>
  latest_draft: {
    body: string                // ReplyForm の初期値にセット
    status: 'pending' | 'ready' | 'failed'
  } | null
}
```

---

## `serverFn: sendReply({ conversationId, body })`

返信送信用。FR-005 〜 FR-008 の中核。AI 下書きをそのまま、編集、または空入力から自由入力で送信できる。**自動送信は実装しない（FR-026）**。

### Input

```ts
{ conversationId: string, body: string }
```

### Behavior

1. JWT 認証確認（ログイン済みなら全機能アクセス可、ロール分岐は MVP では実装しない）
2. `conversations` から取得、`last_inbound_at` が 24h 以内か確認（超過なら `outside_window` エラーを返す）
3. `messages` に `send_status='pending'`, `sent_by_auth_uid=JWT.sub` で INSERT
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

## `serverFn: getDraftStatus({ messageId })` *(任意、ポーリング用)*

スレッド画面で `ai_drafts.status='pending'` の場合に、生成完了をポーリングで検知する用途。

### Input

```ts
{ messageId: string }
```

### Behavior

1. JWT 認証ミドルウェア通過
2. `ai_drafts` を `message_id` で検索
3. `status` と `body` を返却

### Output

```ts
{
  status: 'pending' | 'ready' | 'failed'
  body: string | null
}
```

**運用**: クライアントは 3 秒ごとに最大 60 秒ポーリング、`ready` か `failed` で停止。Phase 2 で WebSocket / Supabase Realtime に移行する選択肢あり。

---

## `serverFn: getPageStatus()`

Page Access Token の有効性確認用（FR-018）。管理画面ヘッダーで定期的（5 分ごと）に呼び出す。

### Input

なし

### Behavior

1. JWT 認証ミドルウェア通過
2. SSM から Page Access Token 取得
3. **DB の `connected_pages` で `is_active=true` を確認 + Send API のドライラン的な軽量呼び出しで疎通確認**（旧版の `/me?fields=id,name` は廃止：Cognito ユーザー情報の代替表示が不要になり、Meta API の不必要な消費を避けるため）
4. 直近で送信失敗（`send_error='token_expired'`）が記録されているかを `messages` から確認
5. 5 分のサーバーキャッシュで結果を返す

### Output

```ts
{
  page_id: string
  page_name: string
  token_valid: boolean
  token_last_checked_at: string
}
```

**実装上の注意**: Meta Graph API への能動的な疎通確認は MVP では行わず、**送信時に発生したエラーから受動的に判定**する方式に簡素化（旧版の `/me` 呼び出しは削除）。能動チェックが必要になったら Phase 2 で `getPageStatus` 内に再追加する。

---

## 認証ミドルウェア

全 `serverFn`（`login` 除く）は以下のミドルウェアを通過する。JWT をステートレスに検証するため DB 参照なし。

```ts
import { createClient } from '@supabase/supabase-js'

// Lambda コンテナ内で 1 回だけ初期化
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
)

middleware: async ({ request }) => {
  const accessToken = getCookie(request, 'sb-access-token')
  if (!accessToken) throw redirect({ to: '/login' })

  // Supabase の getUser は内部で JWT 検証（JWKS）を行う
  const { data, error } = await supabase.auth.getUser(accessToken)

  if (error || !data.user) {
    // Access Token 期限切れなら Refresh Token で再発行を試みる
    const refreshToken = getCookie(request, 'sb-refresh-token')
    if (refreshToken) {
      const refreshed = await supabase.auth.refreshSession({ refresh_token: refreshToken })
      if (refreshed.data.session) {
        // 新 Cookie をセットして user 情報を返す
        setCookie(request, 'sb-access-token', refreshed.data.session.access_token)
        setCookie(request, 'sb-refresh-token', refreshed.data.session.refresh_token)
        return {
          user: {
            id: refreshed.data.session.user.id,
            email: refreshed.data.session.user.email,
            role: refreshed.data.session.user.user_metadata?.role ?? null,
          },
        }
      }
    }
    throw redirect({ to: '/login' })
  }

  return {
    user: {
      id: data.user.id,
      email: data.user.email,
      role: data.user.user_metadata?.role ?? null,
    },
  }
}
```

セッション切れは `/login` へリダイレクト + 元 URL を `returnTo` クエリで保持。

**パフォーマンス最適化**：`supabase.auth.getUser` は内部的に `/auth/v1/user` API を叩くので 1 リクエスト発生する。MVP では許容するが、Phase 2 で JWT を JWKS でローカル検証する独自実装に置き換える選択肢あり（`jose` ライブラリで Supabase JWKS を取得 + キャッシュ）。

---

## テスト

| Test | Type | Coverage |
|------|------|----------|
| 全 serverFn に認証が必要 | integration | 未ログインで呼び出して 401/リダイレクト |
| login 正常系 | integration | Supabase Auth モック → Cookie 発行を確認 |
| login 異常系（不正資格情報）| integration | `AuthError invalid_credentials` モック → 401 |
| login 異常系（banned）| integration | `banned_until` 未来日 → 401（汎用メッセージ）|
| logout | integration | `signOut` 呼び出し + Cookie 削除を確認 |
| JWT 検証（Access Token 有効）| integration | `getUser` 成功 → user 情報取得 |
| JWT 検証（Access Token 期限切れ）| integration | エラー → refreshSession 呼び出し → 新 Token で再検証 |
| JWT 検証（Refresh Token も失効）| integration | 双方失効 → `/login` リダイレクト |
| listConversations 並び順 | integration | last_message_at DESC、fixture で確認 |
| getConversation unread リセット | integration | 呼び出し後に unread_count=0 |
| getConversation AI 下書き含む | integration | inbound + ai_drafts ready/pending/failed/null を fixture で揃え、各 case が正しく返ることを確認 |
| sendReply 成功 | integration | Meta API モック → DB に `sent_by_auth_uid` 付きで sent 記録 |
| sendReply 24h 超過 | unit | API 呼び出し前にエラー |
| sendReply トークン失効 | integration | モック 400 → failed で記録 + エラーメッセージ |
| getDraftStatus pending → ready | integration | ai_drafts UPDATE 後に正しい body が返る |
| getPageStatus | unit | 5 分キャッシュ動作確認、failed message から token_valid 判定 |
