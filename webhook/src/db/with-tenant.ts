import { sql } from 'drizzle-orm'
import type { PostgresJsTransaction } from 'drizzle-orm/postgres-js'
import type { ExtractTablesWithRelations } from 'drizzle-orm'
import type * as schema from './schema'
import { db } from './client'

export type TenantTx = PostgresJsTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>

export async function withTenant<T>(
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.tenant_id = ${tenantId}::text`)
    return fn(tx)
  })
}
