# Contract: `discardDraft` server fn

**File**: `app/src/routes/(app)/threads/$id/-lib/discard-draft.fn.ts`
**Method**: POST
**Auth**: 既存セッション middleware で tenant_id を解決。`withTenant(tenantId, fn)` 経由で RLS 適用。

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
  draftId: string,
  newLifecycleStatus: 'discarded',
} | {
  ok: false,
  error: 'not_found' | 'already_inactive' | 'forbidden',
}
```

## 振る舞い

1. `withTenant(tenantId, async (tx) => { ... })` で開始
2. `SELECT id, lifecycle_status FROM ai_drafts WHERE id = $draftId` で対象を取得
   - 行が存在しない（RLS で他テナント分は見えない）→ `{ ok: false, error: 'not_found' }`
   - `lifecycle_status !== 'active'` → `{ ok: false, error: 'already_inactive' }`（楽観ロック失敗）
3. `UPDATE ai_drafts SET lifecycle_status='discarded', updated_at=NOW() WHERE id=$draftId AND lifecycle_status='active'`
   - 0 行更新だった場合は競合（直前に他オーナーが操作）→ `{ ok: false, error: 'already_inactive' }`
4. ログイベント `draft_discarded` を構造化ログで出力（`request_id`, `tenant_id`, `draft_id`）
5. `{ ok: true, draftId, newLifecycleStatus: 'discarded' }` を返す

## エラー

- `not_found`: draft が存在しない、または RLS で見えない（他テナント）
- `already_inactive`: draft の lifecycle_status が既に `discarded` or `superseded`
- `forbidden`: tenant_id 解決に失敗（middleware で 401 / 403 を返すのが望ましい、ここまで到達しない想定）

`forbidden` 以外はユーザーに「破棄に失敗しました。ページを再読み込みしてください」相当のメッセージを表示。

## クライアント側挙動

- ボタン押下時、optimistic UI で draft 表示を即座に消す
- レスポンスが `ok: false` の場合は元の表示を復元 + エラートースト
- レスポンスが `ok: true` の場合は何もしない（既に消えているため）

## 観測性

| ログイベント | フィールド |
|---|---|
| `draft_discard_requested` | `request_id`, `tenant_id`, `draft_id` |
| `draft_discarded` | 上記 + `latency_ms` |
| `draft_discard_failed` | 上記 + `error` (上記 enum 値) |

## テスト

| ケース | 期待 |
|---|---|
| active draft を破棄 | `ok: true`、DB 上で `lifecycle_status='discarded'` |
| 既に discarded を破棄 | `ok: false, error: 'already_inactive'` |
| 他テナントの draft を破棄 | `ok: false, error: 'not_found'`（RLS で見えない） |
| 存在しない UUID | `ok: false, error: 'not_found'` |
| RLS バイパステスト | tenant A の セッションから tenant B の draft を直接更新できないこと |
