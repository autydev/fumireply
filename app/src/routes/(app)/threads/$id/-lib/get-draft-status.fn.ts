import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { aiDrafts } from '~/server/db/schema'
import { withTenant } from '~/server/db/with-tenant'

const inputSchema = z.object({ conversationId: z.string().uuid() })

export type DraftStatus = {
  status: 'pending' | 'ready' | 'failed'
  body: string | null
  // 005: surfaces the error column. When status='ready' but error is non-null,
  // the previous regenerate attempt failed and the body is the *pre-regenerate*
  // draft. Client uses this to show a transient toast without overwriting the
  // textarea.
  error: string | null
}

export const getDraftStatusFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(inputSchema)
  .handler(async ({ data, context }) => {
    return withTenant(context.user.tenantId, async (tx) => {
      const rows = await tx
        .select({
          status: aiDrafts.status,
          body: aiDrafts.body,
          error: aiDrafts.error,
        })
        .from(aiDrafts)
        .where(
          and(
            eq(aiDrafts.conversationId, data.conversationId),
            inArray(aiDrafts.status, ['pending', 'ready']),
          ),
        )
        .orderBy(desc(aiDrafts.createdAt))
        .limit(1)

      if (rows.length === 0) {
        // No active draft: either dismissed/sent or never created — stop polling.
        return { status: 'ready' as const, body: null, error: null }
      }

      const raw = rows[0].status
      const status: 'pending' | 'ready' | 'failed' =
        raw === 'ready' || raw === 'failed' ? raw : 'pending'
      return { status, body: rows[0].body ?? null, error: rows[0].error ?? null }
    })
  })
