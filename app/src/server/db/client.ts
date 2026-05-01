import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env'
import * as schema from './schema'

type Db = ReturnType<typeof drizzle<typeof schema>>

// Lazy initialization: postgres clients are only created on first DB access.
// This lets the SSG prerender import this module at build time without DATABASE_URL
// being set, while still validating env on the first real request.
function lazyDb(getUrl: () => string): Db {
  let instance: Db | undefined
  const init = (): Db => {
    if (!instance) {
      // Transaction Pooler (port 6543): prepare:false required for Supabase compatibility
      instance = drizzle(postgres(getUrl(), { prepare: false }), { schema })
    }
    return instance
  }
  return new Proxy({} as Db, {
    get(_target, prop: string | symbol) {
      return Reflect.get(init() as object, prop)
    },
  })
}

// anon role client — RLS enforced, used for all normal request handling
export const db = lazyDb(() => env.DATABASE_URL)

// service role client — bypasses RLS, used only for migrations, webhook page_id→tenant_id resolution, and system ops
export const dbAdmin = lazyDb(() => env.DATABASE_URL_SERVICE_ROLE)
