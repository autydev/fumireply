import { createHash, randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { db, dbAdmin } from '~/server/db/client'
import { conversations, deletionLog } from '~/server/db/schema'

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// Local withTenant helper — mirrors the shared helper added in U2.5.
// Uses anon-role db client so RLS (tenant_isolation policy) is enforced.
async function withTenant<T>(tenantId: string, fn: (tx: DbTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.tenant_id = ${tenantId}::text`)
    return fn(tx)
  })
}

export interface DeleteUserDataResult {
  confirmationCode: string
}

/**
 * Deletes all data for a given Messenger PSID across all tenants and
 * records an audit entry in deletion_log.
 *
 * @param psid  - Plain-text Facebook Page-Scoped ID from Meta's callback
 * @param hashSalt - Salt for SHA-256 PSID hash (from SSM)
 */
export async function deleteUserData(
  psid: string,
  hashSalt: string,
): Promise<DeleteUserDataResult> {
  // Service role bypasses RLS to find all tenants that own this PSID.
  const tenantRows = await dbAdmin
    .selectDistinct({ tenantId: conversations.tenantId })
    .from(conversations)
    .where(eq(conversations.customerPsid, psid))

  // One confirmation_code per deletion request (tenant-agnostic).
  const confirmationCode = randomUUID().replace(/-/g, '')
  const psidHash = createHash('sha256').update(hashSalt + psid).digest('hex')

  for (const { tenantId } of tenantRows) {
    await withTenant(tenantId, async (tx) => {
      // DELETE conversations WHERE customer_psid = psid (RLS adds tenant_id filter).
      // ON DELETE CASCADE propagates: conversations → messages → ai_drafts.
      await tx.delete(conversations).where(eq(conversations.customerPsid, psid))

      await tx.insert(deletionLog).values({
        tenantId,
        psidHash,
        confirmationCode,
      })
    })
  }

  return { confirmationCode }
}
