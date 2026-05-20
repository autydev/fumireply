import { eq } from 'drizzle-orm'
import { connectedPages } from '~/server/db/schema'
import { withTenant } from '~/server/db/with-tenant'

export type UpdatePagePromptResult = {
  ok: true
  updatedAt: string
}

export async function handleUpdatePagePrompt(
  tenantId: string,
  pageId: string,
  customPrompt: string,
): Promise<UpdatePagePromptResult> {
  const normalizedPrompt = customPrompt.trim() === '' ? null : customPrompt
  const promptLength = normalizedPrompt?.length ?? 0
  const isNull = normalizedPrompt === null

  try {
    const result = await withTenant(tenantId, async (tx) => {
      return tx
        .update(connectedPages)
        .set({ customPrompt: normalizedPrompt })
        .where(eq(connectedPages.id, pageId))
        .returning({ id: connectedPages.id })
    })

    if (result.length === 0) {
      console.error(
        JSON.stringify({
          event: 'update_page_prompt_failed',
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
        event: 'update_page_prompt_ok',
        tenant_id: tenantId,
        page_id: pageId,
        prompt_length: promptLength,
        is_null: isNull,
      }),
    )

    return { ok: true, updatedAt }
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'PAGE_NOT_FOUND') throw error
    console.error(
      JSON.stringify({
        event: 'update_page_prompt_failed',
        tenant_id: tenantId,
        page_id: pageId,
        code: 'UPDATE_FAILED',
        error: String(error),
      }),
    )
    throw error
  }
}
