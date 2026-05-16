import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { performExchangeAndList } from './exchange-and-list.server'

export type { ExchangeAndListResult } from './exchange-and-list.server'

const Input = z.object({
  shortLivedUserToken: z.string().min(20).max(2000),
})

export const exchangeAndListFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(Input)
  .handler(async ({ data }) => performExchangeAndList(data))
