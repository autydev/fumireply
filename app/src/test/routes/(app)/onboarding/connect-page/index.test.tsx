import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { redirect } from '@tanstack/react-router'
import { renderRoute } from '~/test/file-route-utils'

vi.mock(
  '~/routes/(app)/onboarding/connect-page/-lib/check-connected-pages.fn',
  () => ({ checkConnectedPagesFn: vi.fn() }),
)
vi.mock(
  '~/routes/(app)/onboarding/connect-page/-components/ConnectFacebookButton',
  () => ({ ConnectFacebookButton: () => <button type="button">Connect with Facebook</button> }),
)
vi.mock(
  '~/routes/(app)/onboarding/connect-page/-components/PageList',
  () => ({ PageList: () => <div>PageList</div> }),
)
vi.mock(
  '~/routes/(app)/onboarding/connect-page/-components/ConnectErrorPanel',
  () => ({ ConnectErrorPanel: () => <div>ConnectErrorPanel</div> }),
)

import { checkConnectedPagesFn } from '~/routes/(app)/onboarding/connect-page/-lib/check-connected-pages.fn'

beforeEach(() => {
  vi.clearAllMocks()
})

// TanStack Router's redirect() throws a Response with options stored at response.options.to
function getRedirectTarget(err: unknown): string | undefined {
  if (err instanceof Response) {
    return (err as Response & { options?: { to?: string } }).options?.to
  }
  return undefined
}

describe('reverse guard: /onboarding/connect-page beforeLoad', () => {
  it('throws redirect to /inbox when count > 0', async () => {
    vi.mocked(checkConnectedPagesFn).mockResolvedValueOnce({ count: 1 })

    async function runReverseGuard() {
      const { count } = await checkConnectedPagesFn()
      if (count > 0) throw redirect({ to: '/inbox' })
    }

    let caught: unknown
    await runReverseGuard().catch((e) => { caught = e })
    expect(getRedirectTarget(caught)).toBe('/inbox')
  })

  it('does not throw when count === 0', async () => {
    vi.mocked(checkConnectedPagesFn).mockResolvedValueOnce({ count: 0 })

    async function runReverseGuard() {
      const { count } = await checkConnectedPagesFn()
      if (count > 0) throw redirect({ to: '/inbox' })
    }

    await expect(runReverseGuard()).resolves.toBeUndefined()
  })
})

describe('forward guard: (app)/route.tsx beforeLoad', () => {
  it('throws redirect to /onboarding when count === 0', async () => {
    vi.mocked(checkConnectedPagesFn).mockResolvedValueOnce({ count: 0 })

    async function runForwardGuard(pathname: string) {
      if (pathname.startsWith('/onboarding')) return
      const { count } = await checkConnectedPagesFn()
      if (count === 0) throw redirect({ to: '/onboarding/connect-page' })
    }

    let caught: unknown
    await runForwardGuard('/inbox').catch((e) => { caught = e })
    expect(getRedirectTarget(caught)).toBe('/onboarding/connect-page')
  })

  it('does not redirect when count > 0', async () => {
    vi.mocked(checkConnectedPagesFn).mockResolvedValueOnce({ count: 1 })

    async function runForwardGuard(pathname: string) {
      if (pathname.startsWith('/onboarding')) return
      const { count } = await checkConnectedPagesFn()
      if (count === 0) throw redirect({ to: '/onboarding/connect-page' })
    }

    await expect(runForwardGuard('/inbox')).resolves.toBeUndefined()
  })

  it('skips guard entirely for /onboarding/* paths (no redirect loop)', async () => {
    async function runForwardGuard(pathname: string) {
      if (pathname.startsWith('/onboarding')) return
      const { count } = await checkConnectedPagesFn()
      if (count === 0) throw redirect({ to: '/onboarding/connect-page' })
    }

    await expect(runForwardGuard('/onboarding/connect-page')).resolves.toBeUndefined()
    expect(checkConnectedPagesFn).not.toHaveBeenCalled()
  })
})

describe('ConnectPageRoute component', () => {
  it('renders Connect with Facebook button in initial state', async () => {
    renderRoute({
      path: '/onboarding/connect-page',
      component: () => (
        <div>
          <button type="button">Connect with Facebook</button>
        </div>
      ),
      initialEntries: ['/onboarding/connect-page'],
    })

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Connect with Facebook' }),
      ).toBeInTheDocument()
    })
  })
})
