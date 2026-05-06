# Data Model: App Review Submission Readiness

**Feature**: `002-app-review-submission`
**Date**: 2026-05-06
**Status**: Phase 1 — Design

本機能は **DB スキーマを一切変更しない**。001 で確立されたスキーマをそのまま使い、データの**作成経路**を seed → Connect Page server fn の UPSERT に切り替える。新規エンティティとして HttpOnly でない Cookie ベースの Language Preference を導入するが、これは DB 不在で成立する。

---

## 1. 既存エンティティの再利用

### 1.1 `connected_pages`（既存・無変更）

001 の `app/src/server/db/schema.ts` で定義済み。本機能で書き込み経路のみ変更する。

| カラム | 型 | 制約 | 本機能における役割 |
|---|---|---|---|
| `id` | uuid | PK | UPSERT 対象識別子（自動生成）|
| `tenant_id` | uuid | NOT NULL, FK→tenants.id | UPSERT のキー（1 テナント = 1 ページ制約） |
| `page_id` | text | NOT NULL | Facebook Page ID（Connect 時に設定） |
| `page_name` | text | NOT NULL | 表示名（受信トレイのヘッダー等で使用） |
| `page_access_token_encrypted` | bytea | NOT NULL | AES-256-GCM 暗号化済み長期 Page Access Token |
| `webhook_verify_token_ssm_key` | text | NOT NULL | 既存 SSM パス `/fumireply/review/meta/webhook-verify-token` を参照 |
| `created_at`, `updated_at` | timestamptz | NOT NULL | 行ライフサイクル |

**UPSERT 仕様**:
- conflict target: `tenant_id`
- update set: `page_id`, `page_name`, `page_access_token_encrypted`, `updated_at`
- `tenant_id` は変更不可（JWT から取得した値で固定）

**RLS**: 既存ポリシー（`tenant_id = current_setting('app.tenant_id')::uuid`）を継承。Connect Page server fn は `withTenant(tenant_id, fn)` で RLS を有効化するため、cross-tenant 書き込みは DB 層で防御される。

**Edge Case**: 既存の Edge Cases「既存のテナントに別の Operator が新規接続を試みる」は guard で先に弾くため UPSERT には到達しない。仮に到達しても UPSERT で既存トークンが上書きされるだけ（同一テナントなので意味的に正しい）。

### 1.2 `tenants`（既存・無変更）

001 の Malbek tenant 行をそのまま使う。本機能で新規 tenant を作成しない。

### 1.3 `conversations` / `messages` / `ai_drafts` / `deletion_log`（既存・無変更）

すべて 001 のまま。本機能で書き込み経路は変更しない。撮影前 prep スクリプトが `connected_pages` を削除した場合、関連 `conversations` / `messages` も論理的には不要になるが、physical な削除はせず保持する（外部キー制約による cascading は既存スキーマの定義通り）。

---

## 2. 新規エンティティ（Cookie ベース）

### 2.1 Language Preference

| 属性 | 値 |
|---|---|
| **保存場所** | HTTP Cookie |
| **Cookie 名** | `fumireply_locale` |
| **値** | `en` または `ja` |
| **属性** | `Path=/`, `Max-Age=31536000`（1 年）, `SameSite=Lax`, `Secure` |
| **HttpOnly** | **NO**（クライアント側 Paraglide が JS から読む必要がある） |
| **永続化スコープ** | 同一ブラウザ内のみ（クロスデバイス同期なし） |
| **暗号化** | なし（機密情報ではない） |
| **DB 永続化** | なし |
| **デフォルト値** | `ja`（FR-013、Cookie が未設定の場合 SSR 側で Fallback） |

**ライフサイクル**:
- ユーザーが Header の言語トグルをクリック
- クライアント側で `setLocale('en')`（Paraglide API）を即座に呼ぶ（楽観的更新）
- 並行して `setLocaleFn({ locale: 'en' })` server fn を呼び、レスポンスで `Set-Cookie: fumireply_locale=en; ...` ヘッダが返る
- 以降のリクエストではこの Cookie が SSR で読まれ、サーバ側 Paraglide の locale も `en` に固定される
- ブラウザで Cookie をクリアした場合、次回アクセスはデフォルト `ja` に戻る

**バリデーション**:
- 受信時に `en` / `ja` 以外の値はすべて `ja` として扱う（無効値の sanitization）
- Cookie が複数値（`en, en` 等）になった場合は最初の値を採用

**セキュリティ考慮**:
- HttpOnly でないため XSS で読み取り可能だが、ロケール文字列なので機密性ゼロ → 許容
- CSRF：locale 設定 server fn は副作用が「Cookie 上書き」のみで他データへの影響なし → CSRF トークン不要

---

## 3. データフロー

### 3.1 Connect Page Flow（書き込み）

```
[Operator] /onboarding/connect-page
    ↓ クリック「Connect Facebook Page」
[Client] FB.login({ scope: 'pages_show_list,pages_manage_metadata,pages_read_engagement,pages_messaging' })
    ↓ ポップアップで 4 権限同意
[Client] FB.login のコールバックで shortLivedUserToken 取得
    ↓ POST shortLivedUserToken to server fn
[Server] exchangeAndListFn
    ├ 1. SSM /fumireply/review/meta/app-secret 取得
    ├ 2. fb_exchange_token API 呼び出し → longLivedUserToken
    └ 3. /me/accounts API 呼び出し → pages[]（各 page に長期 Page Access Token）
    ↓ pages[] を Client に返す
[Client] PageList を表示
    ↓ Operator がページ選択
[Client] POST { pageId, pageName, pageAccessToken } to server fn
[Server] connectPageFn (within `withTenant(tenant_id, fn)`)
    ├ 1. POST /v19.0/{pageId}/subscribed_apps?subscribed_fields=messages,messaging_postbacks
    ├ 2. crypto.encrypt(pageAccessToken) で AES-256-GCM 暗号化
    └ 3. INSERT INTO connected_pages ... ON CONFLICT (tenant_id) DO UPDATE SET ...
    ↓ 成功レスポンス
[Client] navigate('/inbox')
[Server] (app)/route.tsx の guard が connected_pages 件数 >= 1 を確認 → 通過
[Operator] /inbox 着地
```

### 3.2 Locale Switch Flow

```
[Operator] Header の "EN" をクリック
[Client] setLocale('en')  // Paraglide の即時更新（FOUC ゼロ）
[Client] POST { locale: 'en' } to setLocaleFn (非同期、楽観的更新)
[Server] setLocaleFn
    └ Set-Cookie: fumireply_locale=en; Path=/; Max-Age=31536000; SameSite=Lax; Secure
    ↓ 200 OK
[Client] 次回ナビゲーション以降、SSR レスポンスの HTML が en で生成される
```

### 3.3 Onboarding Guard Flow

```
[Operator] navigate('/inbox')
[Server] (app)/route.tsx beforeLoad
    ├ JWT から tenant_id 取得
    └ withTenant(tenant_id, async (tx) => {
         const count = await tx.select(count()).from(connected_pages);
         if (count === 0) throw redirect({ to: '/onboarding/connect-page' });
       })
    ↓ count >= 1 → そのまま /inbox へ
```

---

## 4. 状態遷移

### 4.1 Tenant の Connect Page 状態

```
[Initial: 001 deploy 完了]
   |
   | (002 動作開始時)
   v
[Disconnected] (connected_pages.count = 0)
   |
   | Operator が Connect Page フローを完了
   v
[Connected] (connected_pages.count = 1)
   |
   | scripts/prep-screencast.sh で削除
   v
[Disconnected]（撮影前の意図的状態）
```

### 4.2 Locale Preference の状態

```
[Initial: Cookie なし]
   |
   v
[Default: ja]
   |
   | LanguageToggle で 'en' を選択
   v
[en]
   |
   | LanguageToggle で 'ja' を選択
   v
[ja]
   |
   | Cookie 削除（ブラウザ側）
   v
[Initial に戻る]
```

---

## 5. 検証可能性

| エンティティ | 検証方法 |
|---|---|
| connected_pages の UPSERT 経路 | integration test：Graph API モック → server fn 呼出 → DB 行を psql で SELECT して値を確認 |
| AES-256-GCM 暗号化 | unit test：crypto.encrypt → DB 行 → crypto.decrypt で round-trip 一致 |
| RLS 防御 | integration test：別 tenant_id の JWT で connect-page 呼出 → DB 行が他テナントに影響しないこと |
| Onboarding guard | integration test：connected_pages 0 件 → /inbox に GET → 302 to /onboarding/connect-page を確認 |
| 逆 guard | integration test：connected_pages 1 件 → /onboarding/connect-page に GET → 302 to /inbox を確認 |
| Locale Cookie | integration test：setLocaleFn 呼出 → レスポンスの Set-Cookie ヘッダを確認 |
| SSR locale | integration test：Cookie `fumireply_locale=en` を付けて SSR エンドポイントを叩き、HTML 内に英訳文字列が含まれることを確認 |
