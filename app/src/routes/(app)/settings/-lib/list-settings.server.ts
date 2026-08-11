import { desc } from 'drizzle-orm'
import { connectedPages } from '~/server/db/schema'
import { withTenant } from '~/server/db/with-tenant'

export type ConnectedPageSetting = {
  id: string
  pageId: string
  pageName: string
  isActive: boolean
  connectedAt: string
  customPrompt: string | null
  priceGuide: string | null
}

export type ListSettingsResult = {
  connectedPages: ConnectedPageSetting[]
}

export async function handleListSettings(tenantId: string): Promise<ListSettingsResult> {
  try {
    const pages = await withTenant(tenantId, async (tx) => {
      return tx
        .select({
          id: connectedPages.id,
          pageId: connectedPages.pageId,
          pageName: connectedPages.pageName,
          isActive: connectedPages.isActive,
          connectedAt: connectedPages.connectedAt,
          customPrompt: connectedPages.customPrompt,
          priceGuide: connectedPages.priceGuide,
        })
        .from(connectedPages)
        .orderBy(desc(connectedPages.connectedAt))
    })

    console.log(JSON.stringify({ event: 'list_settings_ok', tenant_id: tenantId, page_count: pages.length }))

    return {
      connectedPages: pages.map((p) => ({
        id: p.id,
        pageId: p.pageId,
        pageName: p.pageName,
        isActive: p.isActive,
        connectedAt: p.connectedAt.toISOString(),
        customPrompt: p.customPrompt,
        priceGuide: p.priceGuide,
      })),
    }
  } catch (error) {
    console.error(JSON.stringify({ event: 'list_settings_failed', tenant_id: tenantId, error: String(error) }))
    throw error
  }
}
