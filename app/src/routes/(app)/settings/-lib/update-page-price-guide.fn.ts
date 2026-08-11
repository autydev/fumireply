import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { PRICE_GUIDE_MAX } from '~/lib/settings/char-limits'
import { handleUpdatePagePriceGuide } from './update-page-price-guide.server'

export type { UpdatePagePriceGuideResult } from './update-page-price-guide.server'

export const updatePagePriceGuideInputSchema = z.object({
  connectedPageId: z.string().uuid(),
  priceGuide: z.string().max(PRICE_GUIDE_MAX, { message: 'PRICE_GUIDE_TOO_LONG' }),
})

export const updatePagePriceGuideFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(updatePagePriceGuideInputSchema)
  .handler(async ({ data, context }) => {
    return handleUpdatePagePriceGuide(context.user.tenantId, data.connectedPageId, data.priceGuide)
  })
