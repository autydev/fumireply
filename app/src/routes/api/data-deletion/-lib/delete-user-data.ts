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
  const confirmationCode = randomUUID().replace(/-/g, '')
  const psidHash = createHash('sha256').update(hashSalt + psid).digest('hex')

  // Single atomic service-role transaction: tenant lookup, deletion, and
  // audit insert all run within the same snapshot to prevent TOCTOU races.
  await dbAdmin.transaction(async (tx) => {
    const tenantRows = await tx
      .selectDistinct({ tenantId: conversations.tenantId })
      .from(conversations)
      .where(eq(conversations.customerPsid, psid))

    if (tenantRows.length === 0) return

    const tenantIds = tenantRows.map(({ tenantId }) => tenantId)

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
