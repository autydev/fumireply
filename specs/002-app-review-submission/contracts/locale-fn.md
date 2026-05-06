# Contract: Locale Server Function & SSR Middleware

**Feature**: `002-app-review-submission`
**Date**: 2026-05-06
**実装方式**: TanStack Start `createServerFn` + `createMiddleware`
**配置**: `app/src/lib/i18n/`

i18n の Cookie 読み書きと SSR locale 解決の契約。Paraglide JS のメッセージ呼び出しは別物（`m.button_send()` のような型安全関数）で、本契約はその初期化と永続化を担う。

---

## 1. `setLocaleFn` — 言語選択の永続化

ヘッダーの LanguageToggle がクリックされた時に Cookie を設定する server fn。

### Endpoint

`POST /_serverFn/setLocale`

### Input Schema

```typescript
import { z } from 'zod'

const SetLocaleInput = z.object({
  locale: z.enum(['en', 'ja']),
})
```

### Behavior

1. クライアントから受信した `locale` を validate
2. `Set-Cookie: fumireply_locale={locale}; Path=/; Max-Age=31536000; SameSite=Lax; Secure` をレスポンスヘッダにセット
3. `{ ok: true }` を返す

> **HttpOnly フラグはセットしない**。クライアント側の Paraglide が Cookie を読む必要があるため。

### Output Schema

```typescript
const SetLocaleOutput = z.object({
  ok: z.literal(true),
  locale: z.enum(['en', 'ja']),
})
```

### Error Handling

`locale` が `en` / `ja` 以外の場合は Zod が validation error を投げ、TanStack Start の標準エラーレスポンスが返る（HTTP 400）。クライアント側は楽観的更新を rollback すべきだが、MVP では「ボタンを連打しない限り発生しない」のでロールバック処理は省略。

### 認証

**JWT 認証不要**（locale は機密情報でなく、未ログイン状態でも設定可能にしたい）。ログイン画面でも切替えできる必要があるため。

### Logging

副作用が小さいためログは不要。テレメトリで利用率を追いたければ将来検討。

---

## 2. SSR Locale Resolution Middleware

各リクエストの SSR レンダリング前に Cookie から locale を読んで Paraglide の `setLocale()` を呼ぶ。

### Implementation

```typescript
// app/src/lib/i18n/locale-middleware.ts（疑似コード）
import { createMiddleware } from '@tanstack/start/server'
import { setLocale } from '~/paraglide/runtime'

export const localeMiddleware = createMiddleware()
  .server(({ next, request }) => {
    const cookie = request.headers.get('cookie') ?? ''
    const match = cookie.match(/(?:^|;\s*)fumireply_locale=(en|ja)/)
    const locale = match ? match[1] : 'ja'  // FR-013 デフォルト ja
    setLocale(locale as 'en' | 'ja')
    return next()
  })
```

### Wiring

`app/src/start.ts`（または同等のエントリ）の `createStart` に global middleware として登録：

```typescript
import { createStart } from '@tanstack/react-start'
import { localeMiddleware } from './lib/i18n/locale-middleware'

export const startInstance = createStart({
  defaultServerFnMiddleware: [localeMiddleware],
})
```

### Effect

- SSR レスポンスの HTML 内文字列が Cookie に従った locale で生成される
- クライアント側 hydration 時、JS が同じ Cookie を読んで `setLocale()` を呼ぶため一致が保たれる
- FOUC（Flash Of Untranslated Content）が発生しない

### 例外

- Cookie が不正値（壊れた値、`zh` 等の未対応言語）：fallback to `ja`
- Cookie が複数値：最初の値を採用（`fumireply_locale=en, ja` → `en`）
- Cookie ヘッダが存在しない：fallback to `ja`

### テスト方針

| 入力 | 期待 |
|---|---|
| Cookie `fumireply_locale=en` | SSR HTML 内に英訳文字列 |
| Cookie `fumireply_locale=ja` | SSR HTML 内に日本語 |
| Cookie なし | SSR HTML 内に日本語（デフォルト） |
| Cookie `fumireply_locale=zh` | SSR HTML 内に日本語（フォールバック） |
| Cookie `fumireply_locale=en` で連続 100 リクエスト | 全レスポンスが安定して英語（concurrent 干渉なし） |

> **concurrent 干渉のチェック**: Paraglide の `setLocale` は AsyncLocalStorage で動作するため Lambda の並行実行で干渉しないことを SSR テストで確認する。

---

## 3. Client-side Locale Toggle

`app/src/routes/(app)/-components/LanguageToggle.tsx`（および `(auth)/login` でも使う共通コンポーネント想定）。

### Behavior

```typescript
const handleClick = async (newLocale: 'en' | 'ja') => {
  // 1. 楽観的更新（Paraglide の即時切替）
  setLocale(newLocale)

  // 2. Cookie 設定（非同期）
  await setLocaleFn({ data: { locale: newLocale } })
}
```

### UX 詳細

- 現在 locale はテキストカラーで強調（active=`var(--color-ink)` 黒、inactive=`var(--color-ink-3)` 灰）
- セパレータは縦バー `|`
- ボタンサイズは Header 高さに収まる（fontSize 12, padding 4）

### アクセシビリティ

- `<button>` 要素として実装（div ではない）
- `aria-pressed` で現在 locale を示す
- キーボード操作可能（Tab + Enter）

### 配置

| 画面 | 配置場所 |
|---|---|
| `(app)/route.tsx` Header | 既存 Header コンポーネント右端、ユーザー名の左 |
| `(auth)/login` | LoginForm の上、画面右上に絶対配置 |
| `(public)/*` | **配置しない**（公開ページは i18n 対象外） |

---

## 4. Paraglide メッセージ管理

### ディレクトリ構造

```
app/
├── messages/
│   ├── en.json
│   └── ja.json
└── project.inlang/
    └── settings.json
```

### `messages/en.json` 例（抜粋）

```json
{
  "$schema": "https://inlang.com/schema/inlang-message-format",
  "login_email_label": "Email",
  "login_password_label": "Password",
  "login_submit_button": "Sign in",
  "login_error_invalid_credentials": "Invalid email or password.",
  "onboarding_title": "Connect a Facebook Page",
  "onboarding_description": "To start receiving Messenger conversations, connect a Facebook Page that you administer.",
  "onboarding_connect_button": "Connect Facebook Page",
  "onboarding_consent_denied": "Permission was not granted. Please try again and approve all four permissions.",
  "inbox_filter_all": "All",
  "inbox_filter_unread": "Unread",
  "inbox_filter_draft": "Draft",
  "inbox_filter_overdue": "Overdue",
  "inbox_empty_state": "Select a conversation",
  "thread_window_within_24h": "Within 24h window",
  "thread_window_outside_24h": "Outside 24h window",
  "reply_placeholder": "Enter your reply",
  "reply_send_button": "Send",
  "reply_sending_button": "Sending...",
  "reply_ai_suggestion_label": "AI suggestion",
  "reply_draft_saved": "Draft saved",
  "reply_window_closed_warning": "The 24-hour reply window has closed.",
  "language_toggle_aria": "Switch language to {{target}}"
}
```

### `messages/ja.json` 例（抜粋）

```json
{
  "$schema": "https://inlang.com/schema/inlang-message-format",
  "login_email_label": "メールアドレス",
  "login_password_label": "パスワード",
  "login_submit_button": "ログイン",
  "login_error_invalid_credentials": "メールアドレスまたはパスワードが正しくありません。",
  "onboarding_title": "Facebook ページを接続する",
  "onboarding_description": "Messenger の会話を受信するために、管理者権限のある Facebook ページを接続してください。",
  "onboarding_connect_button": "Facebook ページを接続",
  "onboarding_consent_denied": "権限が付与されなかったため接続できませんでした。再度お試しください。",
  "inbox_filter_all": "すべて",
  "inbox_filter_unread": "未読",
  "inbox_filter_draft": "下書き",
  "inbox_filter_overdue": "期限超過",
  "inbox_empty_state": "会話を選択してください",
  "thread_window_within_24h": "24h窓内",
  "thread_window_outside_24h": "24h窓外",
  "reply_placeholder": "返信を入力してください",
  "reply_send_button": "送信",
  "reply_sending_button": "送信中…",
  "reply_ai_suggestion_label": "AI 下書き",
  "reply_draft_saved": "下書き保存済",
  "reply_window_closed_warning": "24時間窓が閉じているため返信できません。",
  "language_toggle_aria": "言語を {{target}} に切替"
}
```

### キーの同期

`paraglide-js compile` 実行時に両言語ファイルでキーが揃っていないとエラー。CI（GitHub Actions）で `paraglide-js compile` を走らせ、生成物の差分が出ないことを確認する。

### `project.inlang/settings.json`

TanStack 公式 example の設定をそのままコピー：

```json
{
  "$schema": "https://inlang.com/schema/project-settings",
  "sourceLanguageTag": "ja",
  "languageTags": ["ja", "en"],
  "modules": [
    "https://cdn.jsdelivr.net/npm/@inlang/plugin-message-format@latest/dist/index.js"
  ],
  "plugin.inlang.messageFormat": {
    "pathPattern": "./messages/{languageTag}.json"
  }
}
```

> 注: `sourceLanguageTag` は ja に設定（既存実装のソース言語が日本語のため、英語訳が「翻訳」扱いとなる）。
