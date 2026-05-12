import { createServerFn } from '@tanstack/react-start'
import { setCookie } from '@tanstack/react-start/server'
import { z } from 'zod'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { handleExchangeAndList } from './exchange-and-list.server'

export type { ExchangeAndListResult } from './exchange-and-list.server'

const Input = z.object({
  shortLivedUserToken: z.string().min(20).max(2000),
})

export const exchangeAndListFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(Input)
  .handler(async ({ data }) => {
    const { result, encryptedLongToken } = await handleExchangeAndList(data.shortLivedUserToken)

    if (result.ok && encryptedLongToken) {
      setCookie('fb_connect_session', encryptedLongToken.toString('base64'), {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 600,
      })
    }

    return result
  })
