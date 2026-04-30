import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { db } from '../db/client'
import { connectedPages } from '../db/schema'
import { getSsmParameter } from './ssm'
import { eq } from 'drizzle-orm'

const MASTER_KEY_SSM_PATH = '/fumireply/master-encryption-key'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const ALGORITHM = 'aes-256-gcm'

let masterKeyCache: Buffer | null = null

export async function getMasterKey(): Promise<Buffer> {
  if (masterKeyCache) return masterKeyCache
  const hex = await getSsmParameter(MASTER_KEY_SSM_PATH)
  masterKeyCache = Buffer.from(hex, 'hex')
  return masterKeyCache
}

export function clearMasterKeyCache(): void {
  masterKeyCache = null
}

export function encryptToken(plaintext: string, masterKey: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, masterKey, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  // Format: iv (12B) || authTag (16B) || ciphertext
  return Buffer.concat([iv, authTag, ciphertext])
}

export function decryptToken(blob: Buffer, masterKey: Buffer): string {
  if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted blob: too short')
  }
  const iv = blob.subarray(0, IV_LENGTH)
  const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
  const decipher = createDecipheriv(ALGORITHM, masterKey, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

export async function getPageAccessTokenForTenant(tenantId: string): Promise<string> {
  const masterKey = await getMasterKey()
  const rows = await db
    .select({ pageAccessTokenEncrypted: connectedPages.pageAccessTokenEncrypted })
    .from(connectedPages)
    .where(eq(connectedPages.tenantId, tenantId))
    .limit(1)

  if (rows.length === 0) {
    throw new Error(`No connected page found for tenant: ${tenantId}`)
  }

  return decryptToken(rows[0].pageAccessTokenEncrypted, masterKey)
}
