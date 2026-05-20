import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { withTenant } from '~/server/db/with-tenant'
import {
  handleUpdateConversationSettings,
  updateConversationSettingsSchema,
} from './update-conversation-settings.server'

export const updateConversationSettingsFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(updateConversationSettingsSchema)
  .handler(async ({ data, context }) => {
    const tenantId = context.user.tenantId

    const result = await withTenant(tenantId, async (tx) =>
      handleUpdateConversationSettings(tx, tenantId, data),
    )

    if (!result.ok) {
      const err = new Error(result.code)
      throw Object.assign(err, { status: 404 })
    }

    return result
  })
