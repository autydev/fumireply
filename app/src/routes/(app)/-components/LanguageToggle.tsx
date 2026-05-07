import { getLocale, setLocale } from '~/paraglide/runtime'

const COOKIE_NAME = 'fumireply_locale'

export function LanguageToggle() {
  const raw = getLocale()
  const locale: 'en' | 'ja' = raw === 'en' ? 'en' : 'ja'

  function switchTo(next: 'en' | 'ja') {
    if (locale === next) return
    setLocale(next)
    const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : ''
    document.cookie = `${COOKIE_NAME}=${next}; Path=/; SameSite=Lax${secure}`
  }

  const baseBtn = {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
    lineHeight: 1,
    padding: '3px 5px',
    borderRadius: 4,
    transition: 'color 120ms',
  }

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <button
        type="button"
        aria-pressed={locale === 'en'}
        onClick={() => switchTo('en')}
        style={{
          ...baseBtn,
          color: locale === 'en' ? 'var(--color-ink)' : 'var(--color-ink-3)',
        }}
      >
        EN
      </button>
      <span aria-hidden="true" style={{ color: 'var(--color-ink-3)', fontSize: 11 }}>|</span>
      <button
        type="button"
        aria-pressed={locale === 'ja'}
        onClick={() => switchTo('ja')}
        style={{
          ...baseBtn,
          color: locale === 'ja' ? 'var(--color-ink)' : 'var(--color-ink-3)',
        }}
      >
        JA
      </button>
    </div>
  )
}
