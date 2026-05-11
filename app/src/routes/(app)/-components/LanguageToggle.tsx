import { useState } from 'react'
import { getLocale, setLocale } from '~/paraglide/runtime'
import { COOKIE_NAME } from '~/lib/i18n/locale'

export function LanguageToggle() {
  const [locale, setLocaleState] = useState<'en' | 'ja'>(() => {
    const raw = getLocale()
    return raw === 'en' || raw === 'ja' ? raw : 'ja'
  })

  function handleClick(newLocale: 'en' | 'ja') {
    if (newLocale === locale) return
    // Optimistic update: Paraglide switches locale immediately in-process
    setLocaleState(newLocale)
    setLocale(newLocale)
    // Persist locale preference in cookie (non-HttpOnly, safe to set client-side).
    // Omit Secure on HTTP so localhost dev works; Secure is set by SSR setCookie in production.
    const isHttps = typeof location !== 'undefined' && location.protocol === 'https:'
    document.cookie = `${COOKIE_NAME}=${newLocale}; Path=/; Max-Age=31536000; SameSite=Lax${isHttps ? '; Secure' : ''}`
  }

  const btnStyle = (active: boolean) =>
    ({
      background: 'none',
      border: 'none',
      padding: '2px 4px',
      fontSize: 12,
      fontWeight: 600,
      cursor: 'pointer',
      color: active ? 'var(--color-ink)' : 'var(--color-ink-3)',
      transition: 'color 120ms',
      lineHeight: 1,
    }) as const

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '4px 10px',
      }}
    >
      <button type="button" aria-pressed={locale === 'en'} onClick={() => handleClick('en')} style={btnStyle(locale === 'en')}>
        EN
      </button>
      <span aria-hidden="true" style={{ color: 'var(--color-ink-3)', fontSize: 10, userSelect: 'none' }}>|</span>
      <button type="button" aria-pressed={locale === 'ja'} onClick={() => handleClick('ja')} style={btnStyle(locale === 'ja')}>
        JA
      </button>
    </div>
  )
}
