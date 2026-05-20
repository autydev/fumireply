import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { handleListSettings } from './list-settings.server'

export type { ConnectedPageSetting, ListSettingsResult } from './list-settings.server'

export const listSettingsFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    return handleListSettings(context.user.tenantId)
  })
