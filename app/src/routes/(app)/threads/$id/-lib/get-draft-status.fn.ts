import { createServerFn } from '@tanstack/react-start'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { aiDrafts } from '~/server/db/schema'
import { withTenant } from '~/server/db/with-tenant'

const inputSchema = z.object({ messageId: z.string().uuid() })

export type DraftStatus = {
  status: 'pending' | 'ready' | 'failed'
  body: string | null
}

export const getDraftStatusFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(inputSchema)
  .handler(async ({ data, context }) => {
    return withTenant(context.user.tenantId, async (tx) => {
      const rows = await tx
        .select({ status: aiDrafts.status, body: aiDrafts.body })
        .from(aiDrafts)
        .where(eq(aiDrafts.messageId, data.messageId))
        .limit(1)

      if (rows.length === 0) {
        return { status: 'pending' as const, body: null }
      }

      return {
        status: rows[0].status as 'pending' | 'ready' | 'failed',
        body: rows[0].body ?? null,
      }
    })
  })
