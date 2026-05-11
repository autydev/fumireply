import { createServerFn } from '@tanstack/react-start'
import { count, eq } from 'drizzle-orm'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { connectedPages } from '~/server/db/schema'
import type { TenantTx } from '~/server/db/with-tenant'
import { withTenant } from '~/server/db/with-tenant'

export type CheckConnectedPagesResult = { count: number }

// Pure helper: testable with a mock tx + arbitrary tenantId.
export async function countActiveConnectedPages(tx: TenantTx): Promise<number> {
  const rows = await tx
    .select({ value: count() })
    .from(connectedPages)
    .where(eq(connectedPages.isActive, true))
  return rows[0]?.value ?? 0
}

export const checkConnectedPagesFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<CheckConnectedPagesResult> => {
    const tenantId = context.user.tenantId
    const value = await withTenant(tenantId, (tx) => countActiveConnectedPages(tx))
    return { count: value }
  })
