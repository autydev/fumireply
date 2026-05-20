import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { PAGE_PROMPT_MAX } from '~/lib/settings/char-limits'
import { handleUpdatePagePrompt } from './update-page-prompt.server'

export type { UpdatePagePromptResult } from './update-page-prompt.server'

const inputSchema = z.object({
  connectedPageId: z.string().uuid(),
  customPrompt: z.string().max(PAGE_PROMPT_MAX, { message: 'PAGE_PROMPT_TOO_LONG' }),
})

export const updatePagePromptFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(inputSchema)
  .handler(async ({ data, context }) => {
    return handleUpdatePagePrompt(context.user.tenantId, data.connectedPageId, data.customPrompt)
  })
