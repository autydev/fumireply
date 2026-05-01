import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env'
import { getSsmParameter } from '../services/ssm'
import * as schema from './schema'

type Db = ReturnType<typeof drizzle<typeof schema>>

let dbPromise: Promise<Db> | undefined
let dbAdminPromise: Promise<Db> | undefined

function ssmKey(name: string): string {
  return `${env.SSM_PATH_PREFIX.replace(/\/$/, '')}/${name}`
}

async function buildDb(ssmName: string): Promise<Db> {
  const url = await getSsmParameter(ssmKey(ssmName))
  const client = postgres(url, { prepare: false })
  return drizzle(client, { schema })
}

export function getDb(): Promise<Db> {
  if (!dbPromise) dbPromise = buildDb('supabase/db-url')
  return dbPromise
}

export function getDbAdmin(): Promise<Db> {
  if (!dbAdminPromise) dbAdminPromise = buildDb('supabase/db-url-service-role')
  return dbAdminPromise
}
