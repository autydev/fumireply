import { createMiddleware } from '@tanstack/react-start'
import { setLocale } from '~/paraglide/runtime'
import { getLocaleFromCookieHeader } from './locale'

export const localeMiddleware = createMiddleware().server(({ next, request }) => {
  const cookieHeader = request.headers.get('cookie') ?? ''
  const locale = getLocaleFromCookieHeader(cookieHeader)
  setLocale(locale)
  return next()
})
