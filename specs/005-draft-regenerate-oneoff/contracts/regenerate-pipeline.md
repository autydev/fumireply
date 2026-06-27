# Contract: 再生成パイプライン (ワンオフ指示)

**Feature**: AI 下書きの条件付き再生成
**Branch**: `005-draft-regenerate-oneoff`
**Date**: 2026-06-23

app (server fn) → SQS → ai-worker → DB → polling → UI の契約。#004 の `draft-pipeline.md` からの **差分のみ** を規定する。

---

## 1. SQS メッセージ契約 (draft job, 拡張)

### 形式 (#004 互換 + 005 拡張フィールド)

```jsonc
{
  "jobType": "draft",
  "conversationId": "<uuid>",            // 必須
  "triggerType": "regenerate",           // NEW (任意): 'regenerate' が立つときは運営者起点
  "triggerMessageId": "<uuid>",          // 任意: auto-batch 由来のとき必須、regenerate のときは省略
  "instruction": "<string, 1..1000>",    // NEW (任意): triggerType='regenerate' のときだけ意味を持つ
  "triggerTimestamp": "<iso8601>",       // 任意
  "enqueuedAt": "<iso8601>"              // 任意
}
```

**送信パラメータ**:
- `triggerType: 'regenerate'` → `DelaySeconds: 0` (運営者の明示意図なので即時)。
- それ以外 (#004 の auto-batch) → 既存どおり `DelaySeconds: DRAFT_DEBOUNCE_SECONDS` (= 20)。

**冪等性**: at-least-once 配信前提。重複時は同一 active draft への上書きで harmless。`instruction` は本文に PII を含む可能性があるため、SQS のメッセージ可視タイムアウトを過度に長くしない (既存値 60s〜90s を維持)。

### 後方互換

- #004 の `{ jobType:'draft', conversationId, triggerMessageId }` 形式はそのまま受理。
- `triggerType` 未指定 = auto-batch 扱い (`coalesce` 適用、失敗時 `failed`)。
- レガシー `{ messageId }` 形式 (#004 移行期) もそのまま処理。

---

## 2. app server fn 契約: `regenerate-draft.fn.ts` (NEW)

```ts
// app/src/routes/(app)/threads/$id/-lib/regenerate-draft.fn.ts

const inputSchema = z.object({
  conversationId: z.string().uuid(),
  instruction: z.string().max(1000).optional(),
})

export type RegenerateDraftResult =
  | { ok: true }
  | { ok: false; error: 'no_active_draft' | 'validation_failed' | 'enqueue_failed' }

export const regenerateDraftFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(inputSchema)
  .handler(async ({ data, context }) => {
    // 1. withTenant 内で active draft を pending に戻す + error null クリア
    //    affected===0 なら 'no_active_draft' を返す
    // 2. enqueueDraftJob({ conversationId, triggerType: 'regenerate', instruction })
    //    失敗時はロールバックなし (DB は pending のまま) — クライアントは再試行 or 90s タイムアウトで復帰
    // 3. 構造化ログ: { event: 'draft_regenerate_requested', conversationId, instruction_length }
  })
```

**契約詳細**:
- **入力**: `instruction` は trim 前にバリデーション。trim 後に空なら `instruction` を **省略して** enqueue (素の再生成として扱う)。
- **権限**: `authMiddleware` で JWT 検証 → `withTenant` で RLS 適用。`conversationId` のテナント所有確認は RLS 経由 (Row が見えなければ no_active_draft)。
- **状態前提**: active draft (`status IN ('pending','ready')`) が存在することが前提。pending 中の二重発火は **クライアント側 isRegenerating で抑制**、サーバは idempotent に再 enqueue (副作用は worker 側の上書き = harmless)。
- **戻り値**: `{ ok: true }` または `{ ok: false, error }`。

---

## 3. ai-worker `processDraftJob` 契約 (差分)

**入力スキーマ拡張**:

```ts
const DRAFT_BODY_SCHEMA = z.object({
  jobType: z.literal('draft').optional().default('draft'),
  conversationId: z.string().uuid(),
  triggerMessageId: z.string().uuid().optional(),
  triggerType: z.enum(['regenerate']).optional(),  // NEW
  instruction: z.string().max(1000).optional(),    // NEW
})
```

**分岐手順** (`triggerType==='regenerate'` のときの差分):

1. tenant 解決 — 既存どおり。
2. **coalesce 判定をスキップ**: 最新インバウンドの id と triggerMessageId の比較をしない。
3. 設定 / 未返信バッチ / 文脈履歴の取得 — 既存どおり (regenerate でも未返信バッチは「最後の outbound 以降のインバウンドテキスト」)。
4. **未返信が空の場合の扱い** (regenerate のみ): `dismissed` にせず、**履歴文脈だけで生成を続行** (運営者が「履歴を踏まえて指示を加えて作って」と意図しているため)。auto-batch のときだけ `dismissed` で return。
5. プロンプト合成: §4 の OPERATOR_INSTRUCTION ブロックを挿入。
6. Anthropic 呼び出し — 既存どおり。
7. **書込 (regenerate 経路の差分)**:
   - 成功時: `set({ status: 'ready', body: <new>, model, ..., error: null, latencyMs, updatedAt })`
   - 失敗時: `set({ status: 'ready', error: <reason>, updatedAt })` (**body / model 等は触らない**)
8. **書込 (auto-batch 経路)**: 既存どおり (成功時 `ready`、失敗時 `failed`)。

**構造化ログ (新規)**:

| event | 意味 | 追加フィールド |
|---|---|---|
| `draft_regenerate_started` | regenerate ジョブ受信 (coalesce bypass マーカー) | `conversationId`, `instruction_length`, `unanswered_count` |
| `draft_regenerate_failed` | regenerate 失敗 (status=ready 維持) | `conversationId`, `error`, `latencyMs` |
| `draft_persisted` (既存、追加 field) | regenerate 成功時 | 既存に加え `triggerType: 'regenerate'` |

---

## 4. プロンプト合成契約 (差分)

`ai-worker/src/prompt.ts` に新関数 `buildOperatorInstructionBlock(instruction?)` を追加。

```ts
export function buildOperatorInstructionBlock(instruction?: string): string | null {
  const trimmed = (instruction ?? '').trim()
  if (!trimmed) return null
  return [
    '## Operator instruction for this draft',
    'Apply this one-off instruction with HIGHEST priority over the shop policy, tone, customer instructions, and conversation summary above. The customer has NOT seen this instruction — do not quote it or refer to it.',
    '',
    trimmed,
  ].join('\n')
}
```

**System blocks の組み立て順** (`ai-worker/src/handler.ts` 内):

```
[BASE]                            ← cache_control: ephemeral (既存)
[additional]                      ← buildAdditionalSystemPrompt() 出力 (空文字なら省略、既存)
[OPERATOR_INSTRUCTION]            ← NEW: buildOperatorInstructionBlock() 出力 (null なら省略)
[LANGUAGE_DIRECTIVE]              ← 最後段 (既存)
```

**ユーザープロンプト** (`buildUserPrompt(history, unanswered)`): **変更なし**。指示は system 側にのみ載せる。

---

## 5. app server fn 契約: `get-draft-status.fn.ts` (差分)

```ts
// 戻り値型を拡張
export type DraftStatus = {
  status: 'pending' | 'ready' | 'failed'
  body: string | null
  error: string | null  // NEW
}
```

**選択クエリ**: `error` 列を追加で SELECT。`status='ready'` でも `error !== null` なら直前の regenerate が失敗したことを示す (client 側でトースト表示の判定に使う)。

**ポーリング側 (DraftBanner / RegeneratePanel) のルール**:
- `status==='pending'`: ポーリング継続。90 秒経過で停止 + `onError('timeout')` 発火。
- `status==='ready'` かつ `error==null`: 成功。`onReady(body)` 発火、ポーリング停止。
- `status==='ready'` かつ `error!=null`: 失敗 (regenerate 経路)。`onError('regenerate_failed', error)` 発火、ポーリング停止。`body` は旧本文 (= 触らない)。
- `status==='failed'`: 旧来の auto-batch 失敗。既存挙動 (banner 非表示)。

---

## 6. webhook 契約 (差分)

`webhook/src/handler.ts` の inbound テキスト処理に **stale-pending guard** を追加:

```ts
const STALE_PENDING_GUARD_SECONDS = 120

// 既存の "active draft を pending に upsert" の前に
const [existing] = await tx
  .select({ status: aiDrafts.status, updatedAt: aiDrafts.updatedAt })
  .from(aiDrafts)
  .where(and(eq(aiDrafts.conversationId, conv.id), inArray(aiDrafts.status, ['pending', 'ready'])))
  .limit(1)

const isFreshPending =
  existing?.status === 'pending' &&
  Date.now() - existing.updatedAt.getTime() < STALE_PENDING_GUARD_SECONDS * 1000

if (isFreshPending) {
  // 進行中ジョブ (主に regenerate) を優先 → SQS publish スキップ。
  // message_id は更新して "最新インバウンド anchor" を保つ (worker が後続 auto-batch 起動時に最新を参照できるように)
  await tx.update(aiDrafts)
    .set({ messageId: newMsg.id, updatedAt: new Date() })
    .where(and(eq(aiDrafts.conversationId, conv.id), eq(aiDrafts.status, 'pending')))

  console.info({ event: 'draft_enqueue_skipped_fresh_pending', conversationId: conv.id })
  return { conversationId: conv.id, newMessageId: null, needsNameFetch: !conv.customerName }
}

// 以降は #004 のロジック (active draft pending upsert + DelaySeconds 付き enqueue)
```

**ポイント**:
- `newMessageId: null` を返すことで、後続の SQS publish は呼ばれない (既存ロジック)。
- worker が regenerate を終えて `ready` に移ったあと、**もし未取り込みの新着インバウンドがある場合** に追加で auto-batch を起こす経路: ai-worker 側で書き込み完了時に「最新インバウンドが anchor (message_id) より新しい場合は新規 draft ジョブを enqueue する」処理を入れる (R-6)。これは ai-worker → SQS の self-enqueue だが、worker は既に SQS client を持っているので追加コストは小さい。
  - **詳細実装**: `processDraftJob` の最終書込後、`triggerType==='regenerate'` の成功時のみ「最新 inbound 取得 → 自身の処理開始時点より新しいなら `{ triggerType: undefined, triggerMessageId: <latest>, conversationId }` を `DelaySeconds: DRAFT_DEBOUNCE_SECONDS` で enqueue」。

---

## 7. UI 契約 (差分)

### `RegeneratePanel.tsx` (NEW)

```tsx
type Props = {
  conversationId: string
  isVisible: boolean              // 親 (ReplyForm) が draft ready 時に true にする
  onRegenerateStart: () => void   // pending state に遷移
  onRegenerateSuccess: (body: string) => void
  onRegenerateError: (reason: 'timeout' | 'regenerate_failed' | 'enqueue_failed', message?: string) => void
}
```

**挙動**:
- 初期: 「再生成」ボタンのみ表示。クリックで textarea が展開、現在文字数表示。
- textarea: `maxLength=1000`、残り文字数表示。1000 超は input 段階で抑制。
- 「実行」ボタン: `regenerateDraftFn({ data: { conversationId, instruction } })` を呼ぶ → `onRegenerateStart` を発火、ポーリングは親の `DraftBanner` が担当 (status='pending' 検知)。
- 実行中 (`isRegenerating === true`): 実行ボタン非活性、ロード表示。
- 成功/失敗で `onRegenerate*` を発火。

### `ReplyForm.tsx` (MODIFY)

- `isRegenerating: boolean` state を追加。
- `RegeneratePanel` を draft `ready` 時に表示。
- 再生成成功時: 既存の `setBody(draftBody)` で textarea を上書き、`isRegenerating=false`、instruction クリア。
- 再生成失敗/タイムアウト時: トースト表示、`isRegenerating=false`、instruction 保持。

### `DraftBanner.tsx` (MODIFY)

- 新規 prop `mode?: 'auto' | 'regenerate'` (default `'auto'`)。`mode==='regenerate'` の時のみ `REGENERATE_MAX_POLL_MS = 90_000` を使い、それ以外は既存 `MAX_POLL_MS = 60_000` を維持 (#004 の auto-batch UX を壊さない)。
- `onError?: (reason: 'timeout' | 'regenerate_failed', message?: string) => void` を追加。
- `status==='ready' && error!=null` を `onError('regenerate_failed', error)` で親に通知してポーリング停止。
- `ReplyForm` は `isRegenerating ? 'regenerate' : 'auto'` を `mode` に渡す。

---

## 8. テスト契約

### ai-worker
- regenerate ジョブが coalesce を bypass (新着インバウンドが anchor より新しくても skip しない)
- regenerate 失敗時に `status='ready'` 維持、`error` セット、`body` 触らない
- regenerate 成功時に `status='ready'`, body 更新, `error=null`
- OPERATOR_INSTRUCTION ブロックが additional と LANGUAGE_DIRECTIVE の間に挿入される
- instruction 空文字 / undefined のとき OPERATOR_INSTRUCTION ブロックは出ない (回帰)
- regenerate 成功後に未取り込み新着があれば auto-batch を self-enqueue する

### app
- `regenerateDraftFn` が active draft を pending に戻し error をクリアする
- `regenerateDraftFn` が SQS に正しい payload を送る (`triggerType:'regenerate'`, `instruction` 含む)
- `instruction` が 1001 文字で zod エラー
- `get-draft-status` が `error` 列を返す
- 他テナントの conversationId で no_active_draft

### webhook
- active draft が `pending` かつ `updated_at < 120s` のとき新着インバウンドで SQS publish が呼ばれない
- active draft が `pending` だが `updated_at > 120s` のときは通常通り SQS publish (stale guard)

### E2E (Playwright スモーク)
- 下書きが ready の会話 → 「再生成」展開 → instruction 入力 → 実行 → pending バナー → ready で新本文 → instruction 欄が空
- 再生成失敗のモック (Anthropic 401) → トースト + 旧本文維持 + instruction 残存
