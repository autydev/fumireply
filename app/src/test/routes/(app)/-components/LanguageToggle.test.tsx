import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const mockGetLocale = vi.fn<() => string>(() => 'ja')
const mockSetLocale = vi.fn()
vi.mock('~/paraglide/runtime', () => ({
  getLocale: mockGetLocale,
  setLocale: mockSetLocale,
}))

const COOKIE_NAME = 'fumireply_locale'
vi.mock('~/lib/i18n/locale', () => ({
  COOKIE_NAME,
}))

// Allow document.cookie writes to be captured
const cookieWrites: string[] = []
Object.defineProperty(document, 'cookie', {
  set(value: string) {
    cookieWrites.push(value)
  },
  get() {
    return ''
  },
  configurable: true,
})

describe('LanguageToggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cookieWrites.length = 0
    mockGetLocale.mockReturnValue('ja')
  })

  it('renders EN and JA buttons', async () => {
    const { LanguageToggle } = await import('~/routes/(app)/-components/LanguageToggle')
    render(<LanguageToggle />)
    expect(screen.getByRole('button', { name: 'EN' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'JA' })).toBeInTheDocument()
  })

  it('initialises aria-pressed from getLocale() with ja fallback for unknown value', async () => {
    mockGetLocale.mockReturnValue('unknown')
    const { LanguageToggle } = await import('~/routes/(app)/-components/LanguageToggle')
    render(<LanguageToggle />)
    expect(screen.getByRole('button', { name: 'JA' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'EN' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('switches aria-pressed and calls setLocale when EN is clicked', async () => {
    const { LanguageToggle } = await import('~/routes/(app)/-components/LanguageToggle')
    render(<LanguageToggle />)
    fireEvent.click(screen.getByRole('button', { name: 'EN' }))
    expect(mockSetLocale).toHaveBeenCalledWith('en')
    expect(screen.getByRole('button', { name: 'EN' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'JA' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('writes fumireply_locale cookie when locale changes', async () => {
    const { LanguageToggle } = await import('~/routes/(app)/-components/LanguageToggle')
    render(<LanguageToggle />)
    fireEvent.click(screen.getByRole('button', { name: 'EN' }))
    expect(cookieWrites.length).toBe(1)
    expect(cookieWrites[0]).toMatch(`${COOKIE_NAME}=en`)
    expect(cookieWrites[0]).toMatch('Path=/')
    expect(cookieWrites[0]).toMatch('SameSite=Lax')
  })

  it('does not write cookie when same locale button is clicked', async () => {
    mockGetLocale.mockReturnValue('ja')
    const { LanguageToggle } = await import('~/routes/(app)/-components/LanguageToggle')
    render(<LanguageToggle />)
    fireEvent.click(screen.getByRole('button', { name: 'JA' }))
    expect(cookieWrites.length).toBe(0)
    expect(mockSetLocale).not.toHaveBeenCalled()
  })
})
