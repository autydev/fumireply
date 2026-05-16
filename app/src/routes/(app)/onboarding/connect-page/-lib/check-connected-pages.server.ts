import { and, count, eq } from 'drizzle-orm'
import { connectedPages } from '~/server/db/schema'
import type { TenantTx } from '~/server/db/with-tenant'

// Server-only. Counts ACTIVE connected pages for a tenant on a passed tx.
// tenant_id comes from the JWT context in production (never from client input).
// count() can return a bigint-like string from postgres, so the result is
// normalized through Number(). Tests import this directly.
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
