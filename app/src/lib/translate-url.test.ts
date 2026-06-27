import { describe, expect, it } from 'vitest'
import { buildTranslateUrl } from './translate-url'

describe('buildTranslateUrl', () => {
  it('builds a Google Translate URL with auto-detected source and Japanese target by default', () => {
    const url = buildTranslateUrl('Hola amigo')
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://translate.google.com/')
    expect(u.searchParams.get('sl')).toBe('auto')
    expect(u.searchParams.get('tl')).toBe('ja')
    expect(u.searchParams.get('op')).toBe('translate')
    expect(u.searchParams.get('text')).toBe('Hola amigo')
  })

  it('honors the targetLang argument', () => {
    const url = buildTranslateUrl('こんにちは', 'en')
    expect(new URL(url).searchParams.get('tl')).toBe('en')
  })

  it('properly URL-encodes special characters and emoji', () => {
    const tricky = 'Hello & "world"!? 🌍'
    const url = buildTranslateUrl(tricky)
    expect(new URL(url).searchParams.get('text')).toBe(tricky)
  })

  it('handles multi-line text', () => {
    const multi = 'Line 1\nLine 2\nLine 3'
    const url = buildTranslateUrl(multi)
    expect(new URL(url).searchParams.get('text')).toBe(multi)
  })
})
