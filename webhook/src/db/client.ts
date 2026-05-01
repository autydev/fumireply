import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const queryClient = postgres(process.env.DATABASE_URL!, { prepare: false })
const adminClient = postgres(process.env.DATABASE_URL_SERVICE_ROLE!, { prepare: false })

export const db = drizzle(queryClient, { schema })
export const dbAdmin = drizzle(adminClient, { schema })
