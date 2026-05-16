import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { withTenant } from '~/server/db/with-tenant'
import { performCheckConnectedPages } from './check-connected-pages.server'

export const checkConnectedPagesFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { tenantId } = context.user
    return withTenant(tenantId, (tx) => performCheckConnectedPages(tx, tenantId))
  })
