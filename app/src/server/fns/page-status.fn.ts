import { createServerFn } from '@tanstack/react-start'
import { desc, eq } from 'drizzle-orm'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { connectedPages, messages } from '~/server/db/schema'
import { withTenant } from '~/server/db/with-tenant'

export type PageStatus = {
  page_id: string
  page_name: string
  token_valid: boolean
  token_last_checked_at: string
}

const CACHE_TTL_MS = 5 * 60 * 1000

type CacheEntry = { data: PageStatus; expiresAt: number }
const statusCache = new Map<string, CacheEntry>()

export const getPageStatusFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<PageStatus> => {
    const { tenantId } = context.user

    const cached = statusCache.get(tenantId)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data
    }

    const checkedAt = new Date().toISOString()

    const result = await withTenant(tenantId, async (tx) => {
      const pages = await tx
        .select({ pageId: connectedPages.pageId, pageName: connectedPages.pageName })
        .from(connectedPages)
        .limit(1)

      if (pages.length === 0) {
        return {
          page_id: '',
          page_name: '',
          token_valid: false,
          token_last_checked_at: checkedAt,
        } satisfies PageStatus
      }

      const { pageId, pageName } = pages[0]

      // Passive check: if any outbound message recorded token_expired, the token is invalid
      const expired = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.sendError, 'token_expired'))
        .orderBy(desc(messages.createdAt))
        .limit(1)

      return {
        page_id: pageId,
        page_name: pageName,
        token_valid: expired.length === 0,
        token_last_checked_at: checkedAt,
      } satisfies PageStatus
    })

    statusCache.set(tenantId, { data: result, expiresAt: Date.now() + CACHE_TTL_MS })
    return result
  })

export function clearPageStatusCache(tenantId?: string): void {
  if (tenantId) {
    statusCache.delete(tenantId)
  } else {
    statusCache.clear()
  }
}
