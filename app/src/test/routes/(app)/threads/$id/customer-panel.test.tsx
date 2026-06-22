import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { useCustomerPanelOpen } from '~/routes/(app)/threads/$id/-components/CustomerPanel'

function Harness() {
  const { isOpen, toggle } = useCustomerPanelOpen()
  return (
    <div>
      <span data-testid="state">{isOpen ? 'open' : 'closed'}</span>
      <button onClick={toggle}>toggle</button>
    </div>
  )
}

function mockMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

describe('useCustomerPanelOpen — responsive default', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults OPEN on desktop (>= 1280px)', async () => {
    mockMatchMedia(true)
    render(<Harness />)
    // Effect runs after mount and opens the docked panel.
    expect(await screen.findByText('open')).toBeInTheDocument()
  })

  it('defaults CLOSED on mobile (< 1280px) so it never covers the thread', () => {
    mockMatchMedia(false)
    render(<Harness />)
    expect(screen.getByTestId('state')).toHaveTextContent('closed')
  })

  it('toggle flips state (and does not persist across viewports)', () => {
    mockMatchMedia(false) // mobile → starts closed
    render(<Harness />)
    expect(screen.getByTestId('state')).toHaveTextContent('closed')

    act(() => {
      screen.getByRole('button', { name: 'toggle' }).click()
    })
    expect(screen.getByTestId('state')).toHaveTextContent('open')

    // No localStorage write — the key used by the old implementation stays empty.
    expect(localStorage.getItem('customer-panel-open')).toBeNull()
  })
})
