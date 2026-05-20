# Contract: Settings Server Functions

**Feature**: 会話コンテキストの永続化と設定の階層化
**Scope**: `app/src/routes/(app)/settings/-lib/` 配下に置く 2 つの TanStack Start server fn の入出力契約。

すべての server fn は:
- 認証必須 (未ログインなら 401 相当、route loader 側で /login に redirect)
- `withTenant(tenant_id, fn)` 内で実行 (JWT から tenant_id 解決)
- Zod input validator を持つ
- 構造化ログを出す (`{ event, tenant_id, request_id, ... }`)

---

## `list-settings.fn.ts`

接続中ページの一覧と、それぞれのカスタムプロンプトを返す。Settings 画面の loader から呼ばれる。

### Input

なし (テナント JWT から解決)。

### Output

```ts
{
  connectedPages: Array<{
    id: string                  // uuid
    pageId: string              // Facebook page id (varchar)
    pageName: string
    isActive: boolean
    connectedAt: string         // ISO 8601
    customPrompt: string | null
  }>
}
```

### 振る舞い

- `connected_pages` テーブルから現テナントの全ページを取得 (active / inactive 問わず)。
- 結果は `connectedAt DESC` (最新順) で返す。
- 1 件もない場合は `connectedPages: []` を返す (UI は空状態を表示)。

### エラー

- 認証なし: 401 相当 (redirect)
- DB 失敗: 500 (構造化ログで `event: 'list_settings_failed'`)

### ログ

- 成功: `{ event: 'list_settings_ok', tenant_id, page_count }`
- 失敗: `{ event: 'list_settings_failed', tenant_id, error }`

---

## `update-page-prompt.fn.ts`

特定の接続ページの `custom_prompt` を更新する。CustomerPanel 風の autosave (debounce 500ms) で叩かれる。

### Input

```ts
{
  pageId: string         // connected_pages.id (uuid)
  customPrompt: string   // 空文字 OK (空文字は NULL に正規化)
}
```

### Validation (Zod)

```ts
z.object({
  pageId: z.string().uuid(),
  customPrompt: z.string().max(2000, { message: 'PAGE_PROMPT_TOO_LONG' }),
})
```

### Output

```ts
{
  ok: true
  updatedAt: string      // ISO 8601 — UI の AutoSaveBadge に「保存済 X 秒前」を出すため
}
```

### 振る舞い

1. Input を Zod でバリデーション。max 超過は 400 (構造化エラー `code: 'PAGE_PROMPT_TOO_LONG'`)
2. `withTenant` トランザクションで `UPDATE connected_pages SET custom_prompt = $1 WHERE id = $2 AND tenant_id = current_tenant_id()` を実行
3. 影響行数 = 0 なら 404 (`code: 'PAGE_NOT_FOUND'`)
4. 空文字は事前に NULL に正規化 (`customPrompt.trim() === '' ? null : customPrompt`)
5. UPDATE 成功で `updated_at: new Date().toISOString()` を返す

### エラーコード

| コード | HTTP | 意味 |
|---|---|---|
| `PAGE_PROMPT_TOO_LONG` | 400 | 2,000 文字超過 (Zod が拒否) |
| `PAGE_NOT_FOUND` | 404 | 該当 pageId が現テナントに存在しない |
| `UPDATE_FAILED` | 500 | DB エラー |

### ログ

- 成功: `{ event: 'update_page_prompt_ok', tenant_id, page_id, prompt_length, is_null }`
- 失敗: `{ event: 'update_page_prompt_failed', tenant_id, page_id, code, error }`

### マルチテナント安全性

- `withTenant` の RLS により他テナントの page には UPDATE が当たらない (影響行数 = 0 → 404)
- 認証経路は既存の JWT middleware (`server/middleware/`) を再利用
