import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { createCipheriv, randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../schema'
import { eq } from 'drizzle-orm'
const { tenants, connectedPages } = schema

async function getMasterKey(): Promise<Buffer> {
  const ssmPathPrefix = process.env.SSM_PATH_PREFIX ?? '/fumireply/'
  const paramName = `${ssmPathPrefix.replace(/\/$/, '')}/master-encryption-key`
  const client = new SSMClient({})
  const res = await client.send(
    new GetParameterCommand({ Name: paramName, WithDecryption: true }),
  )
  const value = res.Parameter?.Value
  if (!value) throw new Error(`SSM parameter ${paramName} not found`)
  return Buffer.from(value, 'base64')
}

function encryptToken(plaintext: string, masterKey: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]) // 12 + 16 + N bytes
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')

  const pageAccessToken = process.env.META_PAGE_ACCESS_TOKEN
  if (!pageAccessToken) throw new Error('META_PAGE_ACCESS_TOKEN is required')

  const pageId = process.env.META_PAGE_ID
  if (!pageId) throw new Error('META_PAGE_ID is required')

  const pageName = process.env.META_PAGE_NAME
  if (!pageName) throw new Error('META_PAGE_NAME is required')

  const tenantSlug = process.env.TENANT_SLUG ?? 'malbek'
  const tenantName = process.env.TENANT_NAME ?? 'Malbek'

  const ssmPathPrefix = (process.env.SSM_PATH_PREFIX ?? '/fumireply/').replace(/\/$/, '')
  const webhookVerifyTokenSsmKey = `${ssmPathPrefix}/meta/webhook-verify-token`

  const client = postgres(databaseUrl, { prepare: false })
  const db = drizzle(client, { schema })

  console.log(`Seeding tenant: ${tenantSlug}`)
  const [tenant] = await db
    .insert(tenants)
    .values({ slug: tenantSlug, name: tenantName, plan: 'free', status: 'active' })
    .onConflictDoNothing()
    .returning()

  let tenantId: string
  if (tenant) {
    tenantId = tenant.id
    console.log(`Inserted tenant: ${tenantId}`)
  } else {
    const rows = await db.select().from(tenants).where(eq(tenants.slug, tenantSlug)).limit(1)
    const existing = rows[0]
    if (!existing) throw new Error(`Tenant ${tenantSlug} not found after insert conflict`)
    tenantId = existing.id
    console.log(`Tenant already exists: ${tenantId}`)
  }

  console.log('Fetching master encryption key from SSM...')
  const masterKey = await getMasterKey()
  const encrypted = encryptToken(pageAccessToken, masterKey)

  console.log(`Seeding connected_pages for page: ${pageId}`)
  await db
    .insert(connectedPages)
    .values({
      tenantId,
      pageId,
      pageName,
      pageAccessTokenEncrypted: encrypted,
      webhookVerifyTokenSsmKey,
    })
    .onConflictDoNothing()

  console.log('Seed complete.')
  await client.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
