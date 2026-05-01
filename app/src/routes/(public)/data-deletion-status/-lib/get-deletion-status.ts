import { eq } from 'drizzle-orm'
import { dbAdmin } from '~/server/db/client'
import { deletionLog } from '~/server/db/schema'

export async function getDeletionStatusRecord(code: string) {
  // Service role bypasses RLS — status endpoint is public and tenant-agnostic
  const rows = await dbAdmin
    .select({
      confirmationCode: deletionLog.confirmationCode,
      deletedAt: deletionLog.deletedAt,
    })
    .from(deletionLog)
    .where(eq(deletionLog.confirmationCode, code))

  return rows[0] ?? null
}
