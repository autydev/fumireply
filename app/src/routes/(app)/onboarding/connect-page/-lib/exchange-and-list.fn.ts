import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { env } from '~/server/env'
import { getSsmParameter } from '~/server/services/ssm'
import { exchangeUserToken, listPages } from '~/server/services/facebook'

const Input = z.object({
  shortLivedUserToken: z.string().min(20).max(2000),
})

export type ExchangeAndListResult =
  | { ok: true; pages: Array<{ id: string; name: string; pageAccessToken: string }> }
  | { ok: false; error: 'token_expired' | 'permission_missing' | 'no_pages' | 'rate_limited' | 'meta_unavailable' | 'internal_error'; message: string }

export const exchangeAndListFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(Input)
  .handler(async ({ data }): Promise<ExchangeAndListResult> => {
    try {
      const appSecret = await getSsmParameter(env.META_APP_SECRET_SSM_KEY)
      const { accessToken: longToken } = await exchangeUserToken(
        data.shortLivedUserToken,
        env.META_APP_ID,
        appSecret,
      )

      const pages = await listPages(longToken)

      if (pages.length === 0) {
        return { ok: false, error: 'no_pages', message: 'No Facebook Pages found.' }
      }

      return { ok: true, pages }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown'
      if (msg === 'token_expired') return { ok: false, error: 'token_expired', message: 'Token expired.' }
      if (msg === 'permission_missing') return { ok: false, error: 'permission_missing', message: 'Missing pages_show_list permission.' }
      if (msg === 'rate_limited') return { ok: false, error: 'rate_limited', message: 'Rate limited. Please wait.' }
      if (msg === 'meta_unavailable') return { ok: false, error: 'meta_unavailable', message: 'Facebook API unavailable.' }
      return { ok: false, error: 'internal_error', message: 'Internal error.' }
    }
  })
