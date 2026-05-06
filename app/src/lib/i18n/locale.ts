const COOKIE_NAME = 'fumireply_locale'
const VALID_LOCALES = ['en', 'ja'] as const
type Locale = 'en' | 'ja'

export function getLocaleFromCookieHeader(cookieHeader: string): Locale {
  const match = cookieHeader.match(/(?:^|;\s*)fumireply_locale=([^;]+)/)
  const value = match?.[1]?.trim()
  return value === 'en' || value === 'ja' ? value : 'ja'
}

export function serializeLocaleCookie(locale: Locale): string {
  return `${COOKIE_NAME}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`
}

export { VALID_LOCALES }
