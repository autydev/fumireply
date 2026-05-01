import { createHash, randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { dbAdmin } from '~/server/db/client'
import { conversations, deletionLog } from '~/server/db/schema'

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

  const confirmationCode = randomUUID().replace(/-/g, '')
  const psidHash = createHash('sha256').update(hashSalt + psid).digest('hex')

  if (tenantRows.length === 0) {
    return { confirmationCode }
  }

  const tenantIds = tenantRows.map(({ tenantId }) => tenantId)

  // Single atomic service-role transaction: delete across all matching tenants
  // and insert the audit row together — eliminates partial-deletion risk.
  await dbAdmin.transaction(async (tx) => {
    await tx
      .delete(conversations)
      .where(and(inArray(conversations.tenantId, tenantIds), eq(conversations.customerPsid, psid)))

    await tx.insert(deletionLog).values({
      tenantId: tenantIds[0],
      psidHash,
      confirmationCode,
    })
  })

  return { confirmationCode }
}
