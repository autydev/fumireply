import type { ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderRoute } from '~/test/file-route-utils'

// Mocks required by route module imports
vi.mock('~/paraglide/messages', () => ({
  onboarding_title: () => 'Connect Your Facebook Page',
  onboarding_description: () => 'Connect a Facebook Page to start managing Messenger conversations.',
  onboarding_connecting: () => 'Connecting...',
  onboarding_retry_button: () => 'Try again',
  onboarding_already_connected: () => 'Page already connected.',
  onboarding_error_token_expired: () => 'Session expired.',
  onboarding_error_permission_missing: () => 'Permission missing.',
  onboarding_error_subscribe_failed: () => 'Subscribe failed.',
  onboarding_error_generic: () => 'Something went wrong.',
  onboarding_consent_denied: () => 'Permission denied.',
  onboarding_no_pages: () => 'No pages found.',
}))
vi.mock('~/routes/(app)/-components/TokenStatusBanner', () => ({ TokenStatusBanner: () => null }))
vi.mock('~/routes/(app)/-components/LanguageToggle', () => ({ LanguageToggle: () => null }))
vi.mock('~/server/fns/logout.fn', () => ({ logoutFn: vi.fn() }))
vi.mock('~/components/ui/icons', () => ({
  InboxIcon: () => null,
  UsersIcon: () => null,
  PackageIcon: () => null,
  SettingsIcon: () => null,
  LogOutIcon: () => null,
  ChevronDownIcon: () => null,
}))

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
import { Route as ConnectPageIndexRoute } from '~/routes/(app)/onboarding/connect-page/index'
import { Route as AppRoute } from '~/routes/(app)/route'

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

    let caught: unknown
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (ConnectPageIndexRoute.options.beforeLoad as any)({}).catch((e: unknown) => { caught = e })
    expect(getRedirectTarget(caught)).toBe('/inbox')
  })

  it('does not throw when count === 0', async () => {
    vi.mocked(checkConnectedPagesFn).mockResolvedValueOnce({ count: 0 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((ConnectPageIndexRoute.options.beforeLoad as any)({})).resolves.toBeUndefined()
  })
})

describe('forward guard: (app)/route.tsx beforeLoad', () => {
  it('throws redirect to /onboarding when count === 0', async () => {
    vi.mocked(checkConnectedPagesFn).mockResolvedValueOnce({ count: 0 })

    let caught: unknown
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (AppRoute.options.beforeLoad as any)({ location: { pathname: '/inbox' } })
      .catch((e: unknown) => { caught = e })
    expect(getRedirectTarget(caught)).toBe('/onboarding/connect-page')
  })

  it('does not redirect when count > 0', async () => {
    vi.mocked(checkConnectedPagesFn).mockResolvedValueOnce({ count: 1 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((AppRoute.options.beforeLoad as any)({ location: { pathname: '/inbox' } })).resolves.toBeUndefined()
  })

  it('skips guard entirely for /onboarding/* paths (no redirect loop)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((AppRoute.options.beforeLoad as any)({ location: { pathname: '/onboarding/connect-page' } })).resolves.toBeUndefined()
    expect(checkConnectedPagesFn).not.toHaveBeenCalled()
  })
})

describe('ConnectPageRoute component', () => {
  it('renders Connect with Facebook button in initial state', async () => {
    const Component = ConnectPageIndexRoute.options.component!

    renderRoute({
      path: '/onboarding/connect-page',
      // RouteComponent<{}> is callable as () => ReactNode when props is empty
      component: Component as unknown as () => ReactNode,
      initialEntries: ['/onboarding/connect-page'],
    })

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Connect with Facebook' }),
      ).toBeInTheDocument()
    })
  })
})
