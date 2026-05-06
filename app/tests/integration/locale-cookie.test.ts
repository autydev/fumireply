// @vitest-environment node
// Unit: locale cookie helpers — getLocaleFromCookieHeader / serializeLocaleCookie boundary values

import { describe, expect, it } from 'vitest'
import {
  COOKIE_NAME,
  getLocaleFromCookieHeader,
  serializeLocaleCookie,
} from '~/lib/i18n/locale'

describe('getLocaleFromCookieHeader', () => {
  it('returns "en" for fumireply_locale=en', () => {
    expect(getLocaleFromCookieHeader('fumireply_locale=en')).toBe('en')
  })

  it('returns "ja" for fumireply_locale=ja', () => {
    expect(getLocaleFromCookieHeader('fumireply_locale=ja')).toBe('ja')
  })

  it('returns "ja" fallback for empty string', () => {
    expect(getLocaleFromCookieHeader('')).toBe('ja')
  })

  it('returns "ja" fallback for unrelated cookies only', () => {
    expect(getLocaleFromCookieHeader('session=abc; other=xyz')).toBe('ja')
  })

  it('returns "ja" fallback for unknown locale value "zh"', () => {
    expect(getLocaleFromCookieHeader('fumireply_locale=zh')).toBe('ja')
  })

  it('returns "ja" fallback for empty locale value', () => {
    expect(getLocaleFromCookieHeader('fumireply_locale=')).toBe('ja')
  })

  it('returns "ja" fallback for whitespace-only locale value', () => {
    expect(getLocaleFromCookieHeader('fumireply_locale=   ')).toBe('ja')
  })

  it('extracts locale from multi-cookie header — fumireply_locale first', () => {
    expect(getLocaleFromCookieHeader('fumireply_locale=en; session=abc')).toBe('en')
  })

  it('extracts locale from multi-cookie header — fumireply_locale last', () => {
    expect(getLocaleFromCookieHeader('session=abc; fumireply_locale=en')).toBe('en')
  })

  it('extracts locale from multi-cookie header — fumireply_locale in middle', () => {
    expect(getLocaleFromCookieHeader('a=1; fumireply_locale=ja; b=2')).toBe('ja')
  })

  it('handles extra spaces around separator', () => {
    expect(getLocaleFromCookieHeader('session=abc;  fumireply_locale=en')).toBe('en')
  })

  it('returns "ja" for malformed cookie (no value separator)', () => {
    expect(getLocaleFromCookieHeader('fumireply_locale')).toBe('ja')
  })

  it('does not match a cookie whose name contains fumireply_locale as suffix', () => {
    // "other_fumireply_locale=en" should NOT match — the key must be exactly fumireply_locale
    expect(getLocaleFromCookieHeader('other_fumireply_locale=en')).toBe('ja')
  })
})

describe('serializeLocaleCookie', () => {
  it('produces correct cookie string for "en"', () => {
    const cookie = serializeLocaleCookie('en')
    expect(cookie).toContain(`${COOKIE_NAME}=en`)
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Max-Age=31536000')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Secure')
  })

  it('produces correct cookie string for "ja"', () => {
    const cookie = serializeLocaleCookie('ja')
    expect(cookie).toContain(`${COOKIE_NAME}=ja`)
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Max-Age=31536000')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Secure')
  })

  it('does NOT set HttpOnly (client-side Paraglide must read the cookie)', () => {
    expect(serializeLocaleCookie('en').toLowerCase()).not.toContain('httponly')
    expect(serializeLocaleCookie('ja').toLowerCase()).not.toContain('httponly')
  })

  it('COOKIE_NAME in serialized value matches COOKIE_NAME constant', () => {
    expect(serializeLocaleCookie('en')).toMatch(new RegExp(`^${COOKIE_NAME}=`))
  })
})

describe('COOKIE_NAME', () => {
  it('is fumireply_locale', () => {
    expect(COOKIE_NAME).toBe('fumireply_locale')
  })

  it('LOCALE_COOKIE_RE uses the same COOKIE_NAME (read/write name sync)', () => {
    // Writing 'en' via serializeLocaleCookie and reading back must round-trip
    const serialized = serializeLocaleCookie('en').split(';')[0] // "fumireply_locale=en"
    expect(getLocaleFromCookieHeader(serialized)).toBe('en')
  })
})
