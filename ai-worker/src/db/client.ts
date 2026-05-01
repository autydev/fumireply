import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const queryClient = postgres(process.env.DATABASE_URL!, { prepare: false })
const adminClient = postgres(process.env.DATABASE_URL_SERVICE_ROLE!, { prepare: false })

// anon role client — RLS enforced, used for withTenant transactions
export const db = drizzle(queryClient, { schema })

// service role client — bypasses RLS, used only for tenant_id resolution
export const dbAdmin = drizzle(adminClient, { schema })
