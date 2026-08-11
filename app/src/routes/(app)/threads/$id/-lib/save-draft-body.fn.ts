import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { withTenant } from '~/server/db/with-tenant'
import { handleSaveDraftBody, saveDraftBodySchema } from './save-draft-body.server'

export type { SaveDraftBodyResult } from './save-draft-body.server'

export const saveDraftBodyFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(saveDraftBodySchema)
  .handler(async ({ data, context }) =>
    withTenant(context.user.tenantId, (tx) => handleSaveDraftBody(tx, data)),
  )
