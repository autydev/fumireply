import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { aiDrafts } from '~/server/db/schema'
import { withTenant } from '~/server/db/with-tenant'
import { enqueueDraftJob } from '~/server/services/sqs'

// Feature 005: operator-initiated one-off regenerate. Flips the active draft to
// pending, clears the error column, then publishes a draft job to the existing
// SQS queue with triggerType:'regenerate' and the optional instruction.
//
// The instruction is NEVER persisted — it lives only on the SQS message and in
// the worker's prompt composition. UI/client guarantees the textarea is cleared
// on success; spec FR-003 / SC-004 (永続化リーク 0 件).

const INSTRUCTION_MAX = 1000

const inputSchema = z.object({
  conversationId: z.string().uuid(),
  instruction: z.string().max(INSTRUCTION_MAX).optional(),
})

export type RegenerateDraftResult =
  | { ok: true }
  | { ok: false; error: 'no_active_draft' | 'enqueue_failed' }

export const regenerateDraftFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(inputSchema)
  .handler(async ({ data, context }): Promise<RegenerateDraftResult> => {
    const tenantId = context.user.tenantId
    const trimmed = data.instruction?.trim()
    const instructionForPayload = trimmed && trimmed.length > 0 ? trimmed : undefined

    // 1. Flip the active draft to pending (and clear any prior error). RLS via
    //    withTenant scopes the update to the caller's tenant.
    const affected = await withTenant(tenantId, async (tx) => {
      // Prefer an existing active (pending/ready) draft — the normal regenerate
      // path.
      const active = await tx
        .update(aiDrafts)
        .set({ status: 'pending', error: null, updatedAt: new Date() })
        .where(
          and(
            eq(aiDrafts.conversationId, data.conversationId),
            inArray(aiDrafts.status, ['pending', 'ready']),
          ),
        )
        .returning({ id: aiDrafts.id })
      if (active.length > 0) return active.length

      // No active draft: retry after a failed generation. Revive the single most
      // recent failed row (targeted by id) so the pending/ready unique index is
      // never violated by a concurrently-created pending draft.
      const [failed] = await tx
        .select({ id: aiDrafts.id })
        .from(aiDrafts)
        .where(
          and(
            eq(aiDrafts.conversationId, data.conversationId),
            eq(aiDrafts.status, 'failed'),
          ),
        )
        .orderBy(desc(aiDrafts.createdAt))
        .limit(1)
      if (!failed) return 0

      const revived = await tx
        .update(aiDrafts)
        .set({ status: 'pending', error: null, updatedAt: new Date() })
        .where(eq(aiDrafts.id, failed.id))
        .returning({ id: aiDrafts.id })
      return revived.length
    })

    if (affected === 0) {
      return { ok: false, error: 'no_active_draft' }
    }

    // 2. Publish to the existing draft queue. SQS failure does NOT roll back the
    //    pending flip; the client retries (or times out after 90s) and the next
    //    user action will replay the publish.
    try {
      await enqueueDraftJob({
        conversationId: data.conversationId,
        triggerType: 'regenerate',
        instruction: instructionForPayload,
      })
    } catch (err) {
      console.error({
        event: 'draft_regenerate_enqueue_failed',
        conversationId: data.conversationId,
        error: String(err),
      })
      return { ok: false, error: 'enqueue_failed' }
    }

    console.info({
      event: 'draft_regenerate_requested',
      conversationId: data.conversationId,
      // Length only — never log the instruction text (PII risk).
      instruction_length: instructionForPayload?.length ?? 0,
    })
    return { ok: true }
  })
