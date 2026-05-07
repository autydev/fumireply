import { createServerFn } from '@tanstack/react-start'
import { count } from 'drizzle-orm'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { connectedPages } from '~/server/db/schema'
import { withTenant } from '~/server/db/with-tenant'

export const checkConnectedPagesFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const rows = await withTenant(context.user.tenantId, async (tx) => {
      return tx.select({ count: count() }).from(connectedPages)
    })
    return { count: rows[0]?.count ?? 0 }
  })
