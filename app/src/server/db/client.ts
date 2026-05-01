import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import '../env'
import * as schema from './schema'

// Transaction Pooler (port 6543): prepare:false required for Supabase compatibility
const queryClient = postgres(process.env.DATABASE_URL!, { prepare: false })
const adminClient = postgres(process.env.DATABASE_URL_SERVICE_ROLE!, { prepare: false })

// anon role client — RLS enforced, used for all normal request handling
export const db = drizzle(queryClient, { schema })

// service role client — bypasses RLS, used only for migrations, webhook page_id→tenant_id resolution, and system ops
export const dbAdmin = drizzle(adminClient, { schema })
