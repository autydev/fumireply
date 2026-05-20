# Contract: Conversation Server Functions (CustomerPanel)

**Feature**: 会話コンテキストの永続化と設定の階層化
**Scope**: スレッド画面右カラム `CustomerPanel` 用 server fn 群。既存 `get-conversation.fn.ts` への差分と、新規 `update-conversation-settings.fn.ts` の契約。

---

## `get-conversation.fn.ts` (MODIFY)

**既存挙動**: スレッド ID から conversation 行と messages 配列、最新 ai_draft を返す。
**今回の変更**: 返却 conversation オブジェクトに新規 5 列を含める。

### Output 差分 (追加フィールドのみ)

```ts
{
  conversation: {
    // ... 既存フィールド ...
    summary: string | null
    lastSummarizedAt: string | null    // ISO 8601 — UI で「最終要約 X 分前」表示
    tonePreset: 'friendly' | 'professional' | 'concise' | null
    customPrompt: string | null
    note: string | null
  }
  // ... messages, latest_draft などは既存通り ...
}
```

### 振る舞い

- 既存の SELECT を 5 列分拡張するのみ。row count・順序・redirect ロジックに変更なし。
- 未読カウントリセットの既存トランザクションには干渉しない。

### マルチテナント安全性

- 既存通り `withTenant` を継承

---

## `update-conversation-settings.fn.ts` (NEW)

CustomerPanel の編集を保存する。**部分更新**を許容: 渡された field だけ UPDATE する。

### Input

```ts
{
  conversationId: string                                            // uuid
  tonePreset?: 'friendly' | 'professional' | 'concise' | null      // 明示的 null を許容 (= 解除)
  customPrompt?: string                                             // 空文字は NULL に正規化
  note?: string                                                     // 空文字は NULL に正規化
}
```

3 つのオプショナルフィールドは独立。1 つだけ送って 1 列だけ更新できる。送られなかった field は触らない (undefined != null)。

### Validation (Zod)

```ts
z.object({
  conversationId: z.string().uuid(),
  tonePreset: z
    .union([z.enum(['friendly', 'professional', 'concise']), z.null()])
    .optional(),
  customPrompt: z.string().max(1000, { message: 'CUSTOMER_PROMPT_TOO_LONG' }).optional(),
  note: z.string().max(1000, { message: 'NOTE_TOO_LONG' }).optional(),
})
.refine(
  (v) => v.tonePreset !== undefined || v.customPrompt !== undefined || v.note !== undefined,
  { message: 'NO_FIELDS_PROVIDED' },
)
```

### Output

```ts
{
  ok: true
  updatedAt: string      // ISO 8601
}
```

### 振る舞い

1. Zod バリデーション。max 超過は 400
2. 空文字を NULL に正規化:
   - `customPrompt === '' → null`
   - `note === '' → null`
   - `tonePreset` は受け取った値そのまま (null を受け取れば NULL、enum を受け取れば値、undefined なら触らない)
3. `withTenant` トランザクションで動的 SET 句を構築して UPDATE:
   - 渡された field のみ SET に含める
   - 例: `tonePreset` のみ送られた場合 → `UPDATE conversations SET tone_preset = $1 WHERE id = $2`
4. 影響行数 = 0 なら 404 (`code: 'CONVERSATION_NOT_FOUND'`)
5. `updatedAt: new Date().toISOString()` を返す

### エラーコード

| コード | HTTP | 意味 |
|---|---|---|
| `CUSTOMER_PROMPT_TOO_LONG` | 400 | 1,000 文字超過 |
| `NOTE_TOO_LONG` | 400 | 1,000 文字超過 |
| `NO_FIELDS_PROVIDED` | 400 | 3 フィールドすべて undefined |
| `CONVERSATION_NOT_FOUND` | 404 | 該当 conversationId が現テナントに存在しない |
| `UPDATE_FAILED` | 500 | DB エラー |

### ログ

- 成功: `{ event: 'update_conversation_settings_ok', tenant_id, conversation_id, fields_updated: ['tone_preset'|'custom_prompt'|'note'] }`
- 失敗: `{ event: 'update_conversation_settings_failed', tenant_id, conversation_id, code, error }`

### マルチテナント安全性

- `withTenant` の RLS により他テナントの conversation には UPDATE が当たらない (影響行数 = 0 → 404)
- 内部メモ (`note`) は UI 表示用に SELECT は許可されるが、本 fn は UPDATE 経路としてはすべての列で同等の RLS を継承する
