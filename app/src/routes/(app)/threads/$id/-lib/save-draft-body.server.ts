import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { aiDrafts } from '~/server/db/schema'
import type { TenantTx } from '~/server/db/with-tenant'

export const saveDraftBodySchema = z.object({
  conversationId: z.string().uuid(),
  body: z.string(),
})

export type SaveDraftBodyInput = z.infer<typeof saveDraftBodySchema>

export type SaveDraftBodyResult = { ok: true; saved: boolean }

// #83: persists the operator's edits to the conversation's active ready draft so
// a reload restores them (get-conversation returns latest_draft.body).
// Targets status='ready' only — a row that flipped to pending (regenerate) or a
// terminal state (dismissed/superseded) must not be clobbered by a late debounce,
// so those cases fall through to saved:false instead of writing.
export async function handleSaveDraftBody(
  tx: TenantTx,
  data: SaveDraftBodyInput,
): Promise<SaveDraftBodyResult> {
  const rows = await tx
    .update(aiDrafts)
    .set({ body: data.body, updatedAt: new Date() })
    .where(
      and(
        eq(aiDrafts.conversationId, data.conversationId),
        eq(aiDrafts.status, 'ready'),
      ),
    )
    .returning({ id: aiDrafts.id })

  return { ok: true, saved: rows.length > 0 }
}
