import { createHash, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
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

  // DELETE...RETURNING collapses tenant identification and deletion into a
  // single statement, eliminating the TOCTOU window that a prior SELECT→DELETE
  // pattern would have under READ COMMITTED isolation.
  await dbAdmin.transaction(async (tx) => {
    const deleted = await tx
      .delete(conversations)
      .where(eq(conversations.customerPsid, psid))
      .returning({ tenantId: conversations.tenantId })

    if (deleted.length === 0) return

    await tx.insert(deletionLog).values({
      tenantId: deleted[0].tenantId,
      psidHash,
      confirmationCode,
    })
  })

  return { confirmationCode }
}
