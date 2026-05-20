# Contract: AI Draft Prompt Composition

**Feature**: 会話コンテキストの永続化と設定の階層化
**Scope**: ai-worker の draft 経路 (`processDraftJob`) でシステムプロンプトと user プロンプトをどう組み立てるかの契約。

---

## 全体像

Anthropic Messages API への呼び出しは以下の形になる:

```ts
client.messages.create({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 300,
  system: [
    {
      type: 'text',
      text: BASE_SYSTEM_PROMPT,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: composedAdditionalSystemPrompt,   // ページ + トーン + 顧客指示 + 要約
      // cache_control は付けない (毎リクエスト変動するため)
    },
  ],
  messages: [
    { role: 'user', content: userPrompt },     // 直近メッセージ生データ
  ],
})
```

`system` フィールドを 2 ブロック構成にする理由は R-004:
- ブロック 1: 不変なベースプロンプト → ephemeral cache で prefix hit を最大化
- ブロック 2: 可変な追加部分 → キャッシュ対象外

---

## `buildSystemPrompt(parts)` (純粋関数)

`ai-worker/src/prompt.ts` に追加。

### Signature

```ts
export interface SystemPromptParts {
  pagePrompt: string | null         // connected_pages.custom_prompt
  tonePreset: 'friendly' | 'professional' | 'concise' | null
  customerPrompt: string | null     // conversations.custom_prompt
  summary: string | null            // conversations.summary
}

export function buildAdditionalSystemPrompt(parts: SystemPromptParts): string
```

注: `note` (内部メモ) は引数に含まれない (R-008)。

### 合成ロジック

合成順序 (R-004):

```
[2] Page Policy
[3] Customer Tone
[4] Customer Instruction
[5] Conversation Summary
```

各セクションは存在する場合のみ、明確なラベル付きで連結:

```
## Shop policy:
<pagePrompt>

## Customer-specific tone:
<TONE_LABEL[tonePreset]>

## Customer-specific instructions:
<customerPrompt>

## Conversation summary so far:
<summary>
```

すべて null なら空文字を返す (Anthropic API には 2 ブロック目を渡さない分岐を上位で行う)。

### `TONE_LABEL` 対応表

```ts
const TONE_LABEL = {
  friendly: 'Use a friendly, approachable tone. Use casual but polite language.',
  professional: 'Use a professional, business-appropriate tone. Keep replies formal and structured.',
  concise: 'Be concise. Prioritize brevity over warmth. No more than 2 sentences.',
} as const
```

### 不変条件 (テストで固定)

1. すべて null → 空文字
2. 1 つでも非 null → 必ずそのセクションラベルを含み、対応する値を含む
3. 順序は常に Page → Tone → Customer → Summary
4. `note` を含む引数オブジェクトを誤って渡しても (TypeScript で剥がれるが、JS 実行時) 出力に note の内容は現れない (型レベル + ランタイム test の二重防衛)

---

## `buildUserPrompt(history)` (MODIFY)

既存関数を「カーソル以降の text メッセージ最大 50 件」を受け取る形に変更する。

### Signature

```ts
export interface HistoryMessage {
  direction: 'inbound' | 'outbound'
  body: string
  // messageType は呼び出し側で text only にフィルタ済み前提
}

export function buildUserPrompt(history: HistoryMessage[]): string
```

### 振る舞い

既存ロジックを踏襲。`history` が空なら "Generate a reply to the latest customer message." のみ。
それ以外は `Recent conversation:\n[customer]: ...\n[operator]: ...\n\nGenerate a reply to the latest customer message.` の形。

**唯一の変更**: history の取得元クエリが `LIMIT 5` から `messages.timestamp > COALESCE(last_summarized_at, '1970-01-01'::timestamptz) ORDER BY DESC LIMIT 50` に変わる (data-model.md 参照)。関数自体のロジックは変えない (履歴の長さに依存しない)。

---

## `processDraftJob(body)` のフロー (MODIFY)

`ai-worker/src/handler.ts` の draft 経路。

### Input

```ts
{
  messageId: string   // 既存。SQS_BODY_SCHEMA でバリデーション
}
```

### ステップ (新フロー)

1. SQS body をパース (`SQS_BODY_SCHEMA`)
2. `dbAdmin` で `messageId` から `tenant_id` を解決 (既存)
3. `withTenant` トランザクションで以下を一括取得:
   - 対象 message (body, message_type, conversation_id) — 既存
   - `conversations` から `summary, last_summarized_at, tone_preset, custom_prompt` を SELECT (新規)
   - `connected_pages` から `custom_prompt` を SELECT (新規、`conversations.page_id` 経由)
   - `messages` から カーソル以降 text メッセージを timestamp DESC で取得 (`LIMIT 50`)、reverse して ASC に (新規 = `LIMIT 5` の置き換え)
4. `withTenant` トランザクションを閉じる (API 呼び出し中に DB 接続を保持しない、既存設計)
5. `buildAdditionalSystemPrompt({ pagePrompt, tonePreset, customerPrompt, summary })` を呼ぶ
6. Anthropic 呼び出し:
   - `system: [{ base + ephemeral cache }, additionalText が非空なら追加]`
   - `messages: [{ role: 'user', content: buildUserPrompt(history) }]`
7. ai_drafts UPDATE (既存)
8. ログ:
   - `{ event: 'draft_prompt_composed', tenant_id, conversation_id, page_prompt_present, convo_settings_present: { tone: bool, custom: bool }, summary_present, messages_count }`
   - 既存の `draft_completed` / `draft_failed` ログを継続

### 後方互換 (SC-007)

- conversation 行のすべての追加列が NULL かつ page の `custom_prompt` も NULL の場合、`buildAdditionalSystemPrompt` は空文字を返し、追加 system ブロックは Anthropic に渡されない
- この場合、結果として「ベースシステムプロンプト + 直近 (カーソル NULL → 全 text メッセージ最大 50 件) のメッセージ」となり、件数だけが 5 から最大 50 に変わる点が既存挙動との唯一の差異
- 既存テスト (handler.test.ts) は全列 NULL + 短い会話なので 50 件キャップに抵触しない。グリーン継続を期待

---

## ログ仕様

draft 経路に追加するログイベント:

| Event | フィールド |
|---|---|
| `draft_prompt_composed` | tenant_id, conversation_id, page_prompt_present (bool), tone_present (bool), customer_prompt_present (bool), summary_present (bool), messages_count (number) |
| `draft_settings_fetch_failed` | tenant_id, conversation_id, error — page/conversation の追加列取得失敗 (致命的、fallback で全 null として続行) |

`draft_settings_fetch_failed` 時は安全側に倒して全 null として composition を続行する (FR-024 の精神を draft にも適用)。
