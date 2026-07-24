import { eq } from 'drizzle-orm'
import { connectedPages } from '~/server/db/schema'
import { withTenant } from '~/server/db/with-tenant'

export type UpdatePagePriceGuideResult = {
  ok: true
  updatedAt: string
}

export async function handleUpdatePagePriceGuide(
  tenantId: string,
  pageId: string,
  priceGuide: string,
): Promise<UpdatePagePriceGuideResult> {
  const normalized = priceGuide.trim() === '' ? null : priceGuide
  const length = normalized?.length ?? 0
  const isNull = normalized === null

  try {
    const result = await withTenant(tenantId, async (tx) => {
      return tx
        .update(connectedPages)
        .set({ priceGuide: normalized })
        .where(eq(connectedPages.id, pageId))
        .returning({ id: connectedPages.id })
    })

    if (result.length === 0) {
      console.error(
        JSON.stringify({
          event: 'update_page_price_guide_failed',
          tenant_id: tenantId,
          page_id: pageId,
          code: 'PAGE_NOT_FOUND',
        }),
      )
      const err = Object.assign(new Error('PAGE_NOT_FOUND'), { code: 'PAGE_NOT_FOUND', statusCode: 404 })
      throw err
    }

    const updatedAt = new Date().toISOString()
    console.log(
      JSON.stringify({
        event: 'update_page_price_guide_ok',
        tenant_id: tenantId,
        page_id: pageId,
        price_guide_length: length,
        is_null: isNull,
      }),
    )

    return { ok: true, updatedAt }
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'PAGE_NOT_FOUND') throw error
    console.error(
      JSON.stringify({
        event: 'update_page_price_guide_failed',
        tenant_id: tenantId,
        page_id: pageId,
        code: 'UPDATE_FAILED',
        error: String(error),
      }),
    )
    throw error
  }
}
