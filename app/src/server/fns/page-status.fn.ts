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

function pruneCache(): void {
  const now = Date.now()
  for (const [key, entry] of statusCache) {
    if (entry.expiresAt <= now) statusCache.delete(key)
  }
}

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
        .where(eq(connectedPages.isActive, true))
        .orderBy(desc(connectedPages.connectedAt))
        .limit(1)

      // No connected page is not a token error — return valid to avoid false-positive banner
      if (pages.length === 0) {
        return {
          page_id: '',
          page_name: '',
          token_valid: true,
          token_last_checked_at: checkedAt,
        } satisfies PageStatus
      }

      const { pageId, pageName } = pages[0]

      // Passive check: inspect most recent outbound message's send_error.
      // Checking only the latest avoids false positives when the token was refreshed
      // and subsequent sends succeeded after an earlier token_expired failure.
      const recentOutbound = await tx
        .select({ sendError: messages.sendError })
        .from(messages)
        .where(eq(messages.direction, 'outbound'))
        .orderBy(desc(messages.timestamp))
        .limit(1)

      const tokenValid =
        recentOutbound.length === 0 || recentOutbound[0].sendError !== 'token_expired'

      return {
        page_id: pageId,
        page_name: pageName,
        token_valid: tokenValid,
        token_last_checked_at: checkedAt,
      } satisfies PageStatus
    })

    pruneCache()
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
