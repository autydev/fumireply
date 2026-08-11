import { createServerFn } from '@tanstack/react-start'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { aiDrafts } from '~/server/db/schema'
import { withTenant } from '~/server/db/with-tenant'

const inputSchema = z.object({ conversationId: z.string().uuid() })

// Marks the conversation's active draft as dismissed so it is not re-shown after
// the operator discards it. Includes 'failed' so discarding also clears a draft
// whose generation failed (and its retry error). Idempotent — a no-op when there
// is no active draft.
export const dismissDraftFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(inputSchema)
  .handler(async ({ data, context }) => {
    await withTenant(context.user.tenantId, async (tx) => {
      await tx
        .update(aiDrafts)
        .set({ status: 'dismissed', updatedAt: new Date() })
        .where(
          and(
            eq(aiDrafts.conversationId, data.conversationId),
            inArray(aiDrafts.status, ['pending', 'ready', 'failed']),
          ),
        )
    })
    return { ok: true as const }
  })
