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

// Tenant-scoped client — uses the regular Postgres role from DATABASE_URL
// (no BYPASSRLS attribute), so the tenant_isolation RLS policies apply.
// Always wrap queries in withTenant(tenantId, ...) so SET LOCAL app.tenant_id
// activates the policy. Despite the historical "anon" naming used elsewhere,
// no PostgREST role switching happens here — Drizzle talks to Postgres
// directly with whatever single role DATABASE_URL specifies.
export const db = lazyDb(() => env.DATABASE_URL)

// System ops client — uses the service_role connection (BYPASSRLS).
// Use only for privileged paths that must read/write across tenants:
// the auth middleware's tenants.status lookup, the webhook's
// page_id → tenant_id resolution, data-deletion admin, and migrations.
export const dbAdmin = lazyDb(() => env.DATABASE_URL_SERVICE_ROLE)
