// 007: free, zero-API-key translation helper. Builds a Google Translate web URL
// that auto-detects source language and translates to the operator-friendly
// target. The link opens in a new tab so customer message content (PII) is
// disclosed to Google only on the operator's explicit click.
//
// Trade-off vs server-side translation: zero cost, zero infra, no rate limit,
// but the operator leaves the app momentarily and the body is sent to Google.

const TRANSLATE_BASE = 'https://translate.google.com/'

/**
 * Build a Google Translate URL that auto-detects source language and outputs
 * the given target language. Text is URL-encoded; Messenger messages are
 * normally well under any practical URL length limit.
 */
export function buildTranslateUrl(text: string, targetLang: 'ja' | 'en' = 'ja'): string {
  const params = new URLSearchParams({
    sl: 'auto',
    tl: targetLang,
    text,
    op: 'translate',
  })
  return `${TRANSLATE_BASE}?${params.toString()}`
}
