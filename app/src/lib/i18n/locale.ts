const COOKIE_NAME = 'fumireply_locale'
const VALID_LOCALES = ['en', 'ja'] as const
type Locale = 'en' | 'ja'

// Pre-built once; uses COOKIE_NAME so name + regex stay in sync
const LOCALE_COOKIE_RE = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`)

export function getLocaleFromCookieHeader(cookieHeader: string): Locale {
  const match = cookieHeader.match(LOCALE_COOKIE_RE)
  const value = match?.[1]?.trim()
  return value === 'en' || value === 'ja' ? value : 'ja'
}

export function serializeLocaleCookie(locale: Locale): string {
  return `${COOKIE_NAME}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`
}

export { COOKIE_NAME, VALID_LOCALES }
