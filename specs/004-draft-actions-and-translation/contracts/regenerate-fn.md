# Contract: `regenerateDraft` server fn

**File**: `app/src/routes/(app)/threads/$id/-lib/regenerate-draft.fn.ts`
**Method**: POST
**Auth**: 既存セッション middleware。`withTenant(tenantId, fn)` 経由で RLS 適用。

## Input (Zod)

```ts
z.object({
  draftId: z.string().uuid(),
})
```

## Output

```ts
{
  ok: true,
  oldDraftId: string,
  newDraftId: string,
} | {
  ok: false,
  error: 'not_found' | 'already_inactive' | 'enqueue_failed',
}
```

## 振る舞い

1. `withTenant(tenantId, async (tx) => { ... })` で開始
2. `SELECT id, message_id, lifecycle_status FROM ai_drafts WHERE id=$draftId` で対象を取得
   - 行が存在しない → `{ ok: false, error: 'not_found' }`
   - `lifecycle_status !== 'active'` → `{ ok: false, error: 'already_inactive' }`
3. トランザクション内で 2 ステップ:
   - 旧 draft を `lifecycle_status='superseded'` に UPDATE
   - 新 draft 行を INSERT: `(message_id=旧 message_id, status='pending', lifecycle_status='active', body=null, ...)`
   - partial unique index `(message_id) WHERE lifecycle_status='active'` により、旧が `superseded` になった瞬間にスロットが空き、新を INSERT 可能
4. トランザクション成功後、既存の AI ドラフト生成 SQS キュー（spec 003 で利用中）に「draft 再生成ジョブ」を enqueue
   - SQS message body: `{ draftId: newDraftId, jobType: 'draft' }`（既存メッセージ形式踏襲）
5. enqueue 失敗時はトランザクションをロールバックし、`{ ok: false, error: 'enqueue_failed' }`
   - 注: トランザクション完了後の enqueue 失敗は補償手動。SQS の可用性が高いため通常発生しない
6. ログイベント `draft_regeneration_requested` 出力
7. `{ ok: true, oldDraftId, newDraftId }` を返す

## エラー

- `not_found`: 旧 draft が存在しない、または RLS で見えない
- `already_inactive`: lifecycle_status が `active` 以外
- `enqueue_failed`: SQS への enqueue が失敗、または上記の競合検出

## クライアント側挙動

- ボタン押下時、UI を「生成中」表示に切り替え。両ボタン（破棄・再生成）を disable
- レスポンスが `ok: true` の場合、新 draft 行の `id`（newDraftId）を保持し、`getDraftStatus` ポーリング（既存パターン）で `status='ready'` まで待つ
- ポーリング完了で UI 反映、ボタンを enable

## 観測性

| ログイベント | フィールド |
|---|---|
| `draft_regeneration_requested` | `request_id`, `tenant_id`, `old_draft_id`, `new_draft_id` |
| `draft_regeneration_enqueued` | 上記 + `latency_ms` |
| `draft_regeneration_failed` | 上記 + `error` |

## テスト

| ケース | 期待 |
|---|---|
| active draft を再生成 | `ok: true`、旧 `lifecycle_status='superseded'`、新行が INSERT、SQS に enqueue |
| 既に superseded を再生成 | `ok: false, error: 'already_inactive'` |
| 他テナントの draft | `ok: false, error: 'not_found'` |
| partial unique index 違反 | 同一 message_id に active が複数になる SQL を直接流して制約エラーを観測 |
| SQS enqueue 失敗（mock） | `ok: false, error: 'enqueue_failed'`、DB はロールバック |
