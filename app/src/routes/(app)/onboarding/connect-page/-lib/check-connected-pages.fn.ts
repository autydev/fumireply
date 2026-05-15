import { createServerFn } from '@tanstack/react-start'
import { and, count, eq } from 'drizzle-orm'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { connectedPages } from '~/server/db/schema'
import { withTenant, type TenantTx } from '~/server/db/with-tenant'

// Exported for integration testing — counts ACTIVE connected pages for a tenant
// on a passed tx. tenant_id comes from the JWT context in production (never from
// client input). count() can return a bigint-like string from postgres, so the
// result is normalized through Number().
export async function performCheckConnectedPages(
  tx: TenantTx,
  tenantId: string,
): Promise<{ count: number }> {
  const rows = await tx
    .select({ count: count() })
    .from(connectedPages)
    .where(and(eq(connectedPages.tenantId, tenantId), eq(connectedPages.isActive, true)))
  return { count: Number(rows[0]?.count ?? 0) }
}

export const checkConnectedPagesFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { tenantId } = context.user
    return withTenant(tenantId, (tx) => performCheckConnectedPages(tx, tenantId))
  })
