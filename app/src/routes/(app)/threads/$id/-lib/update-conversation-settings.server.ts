import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { conversations } from '~/server/db/schema'
import type { TenantTx } from '~/server/db/with-tenant'

export const updateConversationSettingsSchema = z
  .object({
    conversationId: z.string().uuid(),
    tonePreset: z
      .union([z.enum(['friendly', 'professional', 'concise']), z.null()])
      .optional(),
    customPrompt: z.string().max(1000, { message: 'CUSTOMER_PROMPT_TOO_LONG' }).optional(),
    note: z.string().max(1000, { message: 'NOTE_TOO_LONG' }).optional(),
  })
  .refine(
    (v) => v.tonePreset !== undefined || v.customPrompt !== undefined || v.note !== undefined,
    { message: 'NO_FIELDS_PROVIDED' },
  )

export type UpdateConversationSettingsInput = z.infer<typeof updateConversationSettingsSchema>

export type UpdateConversationSettingsResult =
  | { ok: true; updatedAt: string }
  | { ok: false; code: string }

export async function handleUpdateConversationSettings(
  tx: TenantTx,
  tenantId: string,
  data: UpdateConversationSettingsInput,
): Promise<UpdateConversationSettingsResult> {
  type SetClause = {
    tonePreset?: string | null
    customPrompt?: string | null
    note?: string | null
  }
  const set: SetClause = {}

  if (data.tonePreset !== undefined) {
    set.tonePreset = data.tonePreset
  }
  if (data.customPrompt !== undefined) {
    set.customPrompt = data.customPrompt === '' ? null : data.customPrompt
  }
  if (data.note !== undefined) {
    set.note = data.note === '' ? null : data.note
  }

  const rows = await tx
    .update(conversations)
    .set(set)
    .where(eq(conversations.id, data.conversationId))
    .returning({ id: conversations.id })

  if (rows.length === 0) {
    console.log(JSON.stringify({
      event: 'update_conversation_settings_failed',
      tenant_id: tenantId,
      conversation_id: data.conversationId,
      code: 'CONVERSATION_NOT_FOUND',
    }))
    return { ok: false, code: 'CONVERSATION_NOT_FOUND' }
  }

  const fieldsUpdated: string[] = []
  if (data.tonePreset !== undefined) fieldsUpdated.push('tone_preset')
  if (data.customPrompt !== undefined) fieldsUpdated.push('custom_prompt')
  if (data.note !== undefined) fieldsUpdated.push('note')

  console.log(JSON.stringify({
    event: 'update_conversation_settings_ok',
    tenant_id: tenantId,
    conversation_id: data.conversationId,
    fields_updated: fieldsUpdated,
  }))

  return { ok: true, updatedAt: new Date().toISOString() }
}
