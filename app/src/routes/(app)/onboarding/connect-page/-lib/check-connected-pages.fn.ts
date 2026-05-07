import { createServerFn } from '@tanstack/react-start'
import { and, count, eq } from 'drizzle-orm'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { connectedPages } from '~/server/db/schema'
import { withTenant } from '~/server/db/with-tenant'

export const checkConnectedPagesFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { tenantId } = context.user
    const rows = await withTenant(tenantId, async (tx) => {
      return tx
        .select({ count: count() })
        .from(connectedPages)
        .where(and(eq(connectedPages.tenantId, tenantId), eq(connectedPages.isActive, true)))
    })
    return { count: Number(rows[0]?.count ?? 0) }
  })
