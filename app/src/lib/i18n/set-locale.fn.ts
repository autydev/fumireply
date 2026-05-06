import { createServerFn } from '@tanstack/react-start'
import { setCookie } from '@tanstack/react-start/server'
import { z } from 'zod'

const SetLocaleInput = z.object({
  locale: z.enum(['en', 'ja']),
})

export const setLocaleFn = createServerFn({ method: 'POST' })
  .inputValidator(SetLocaleInput)
  .handler(async ({ data }) => {
    // HttpOnly is intentionally NOT set — client-side Paraglide reads this cookie
    setCookie('fumireply_locale', data.locale, {
      path: '/',
      maxAge: 31536000,
      sameSite: 'lax',
      secure: true,
    })
    return { ok: true as const, locale: data.locale }
  })
