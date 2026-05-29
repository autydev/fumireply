import { createFileRoute, Outlet, Link, useRouter, useLocation, redirect } from '@tanstack/react-router'
import { TokenStatusBanner } from './-components/TokenStatusBanner'
import { LanguageToggle } from './-components/LanguageToggle'
import { logoutFn } from '~/server/fns/logout.fn'
import { checkConnectedPagesFn } from './onboarding/connect-page/-lib/check-connected-pages.fn'
import {
  InboxIcon,
  UsersIcon,
  PackageIcon,
  SettingsIcon,
  LogOutIcon,
  ChevronDownIcon,
} from '~/components/ui/icons'
import { m } from '~/paraglide/messages'

export const Route = createFileRoute('/(app)')({
  beforeLoad: async ({ location }) => {
    if (location.pathname.startsWith('/onboarding')) return
    const { count } = await checkConnectedPagesFn()
    if (count === 0) {
      throw redirect({ to: '/onboarding/connect-page' })
    }
  },
  component: AppLayout,
})

function AppLayout() {
  const location = useLocation()
  // Thread detail and onboarding are focused full-screen flows on mobile;
  // suppress the global top/bottom chrome so they get the full viewport.
  const hideChrome =
    location.pathname.startsWith('/threads') || location.pathname.startsWith('/onboarding')

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100dvh',
        background: 'var(--color-bg)',
        overflow: 'hidden',
      }}
    >
      {!hideChrome && <MobileTopBar />}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
        <Sidebar />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          <TokenStatusBanner />
          <Outlet />
        </div>
      </div>
      {!hideChrome && <MobileBottomNav />}
    </div>
  )
}

type NavHref = '/inbox' | '/settings'

type NavItem = {
  key: string
  label: () => string
  icon: React.ComponentType<{ size?: number }>
  href: NavHref | '#'
}

const NAV_ITEMS: NavItem[] = [
  { key: 'inbox', label: m.nav_inbox, icon: InboxIcon, href: '/inbox' },
  { key: 'customers', label: m.nav_customers, icon: UsersIcon, href: '#' },
  { key: 'products', label: m.nav_products, icon: PackageIcon, href: '#' },
  { key: 'settings', label: m.nav_settings, icon: SettingsIcon, href: '/settings' },
]

function Sidebar() {
  const router = useRouter()
  const location = useLocation()

  async function handleLogout() {
    await logoutFn()
    await router.navigate({ to: '/login', search: { returnTo: undefined, error: undefined } })
  }

  return (
    <div
      className="app-sidebar"
      style={{
        background: 'var(--color-bg-sunken)',
        borderRight: '1px solid var(--color-line)',
        padding: '14px 10px 10px',
      }}
    >
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px 18px' }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-violet) 100%)',
            display: 'grid',
            placeItems: 'center',
            color: 'white',
            fontWeight: 800,
            fontSize: 14,
            letterSpacing: '-0.02em',
            boxShadow: 'var(--shadow-sm), inset 0 1px 0 rgba(255,255,255,0.25)',
            flexShrink: 0,
          }}
        >
          F
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, letterSpacing: '-0.01em' }}>Fumireply</div>
          <div style={{ fontSize: 11, color: 'var(--color-ink-3)', fontFamily: 'var(--font-mono)', letterSpacing: '-0.02em' }}>v0.1.0</div>
        </div>
      </div>

      {/* Nav */}
      <nav>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const isDisabled = item.href === '#'
          const isActive = !isDisabled && location.pathname.startsWith(item.href)
          const sharedStyle = {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '7px 10px',
            borderRadius: 8,
            fontSize: '13.5px',
            fontWeight: 500,
            color: isActive ? 'var(--color-ink)' : 'var(--color-ink-2)',
            background: isActive ? 'white' : 'transparent',
            boxShadow: isActive ? 'var(--shadow-xs)' : 'none',
            textDecoration: 'none',
            position: 'relative' as const,
            cursor: isDisabled ? 'default' : 'pointer',
            opacity: isDisabled ? 0.45 : 1,
            transition: 'background 120ms, color 120ms',
          }

          if (isDisabled) {
            return (
              <span key={item.key} aria-disabled="true" style={sharedStyle}>
                <Icon size={15} />
                <span>{item.label()}</span>
              </span>
            )
          }

          return (
            <Link
              key={item.key}
              to={item.href as NavHref}
              style={sharedStyle}
              onMouseEnter={(e) => {
                if (!isActive) {
                  e.currentTarget.style.background = 'var(--color-bg-hover)'
                  e.currentTarget.style.color = 'var(--color-ink)'
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = 'var(--color-ink-2)'
                }
              }}
            >
              {isActive && (
                <span
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: '50%',
                    transform: 'translate(-10px, -50%)',
                    width: 3,
                    height: 16,
                    background: 'var(--color-primary)',
                    borderRadius: 2,
                  }}
                />
              )}
              <Icon size={15} />
              <span>{item.label()}</span>
            </Link>
          )
        })}
      </nav>

      {/* Footer */}
      <div
        style={{
          marginTop: 'auto',
          paddingTop: 10,
          borderTop: '1px solid var(--color-line)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end', paddingBottom: 8 }}>
          <LanguageToggle />
        </div>
        <button
          onClick={handleLogout}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '7px 10px',
            borderRadius: 8,
            fontSize: '13px',
            fontWeight: 500,
            color: 'var(--color-ink-3)',
            width: '100%',
            cursor: 'pointer',
            transition: 'background 120ms, color 120ms',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--color-bg-hover)'
            e.currentTarget.style.color = 'var(--color-ink)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.color = 'var(--color-ink-3)'
          }}
        >
          <LogOutIcon size={14} />
          <span>{m.nav_logout()}</span>
          <ChevronDownIcon size={12} style={{ marginLeft: 'auto', opacity: 0 }} />
        </button>
      </div>
    </div>
  )
}

function MobileTopBar() {
  const router = useRouter()

  async function handleLogout() {
    await logoutFn()
    await router.navigate({ to: '/login', search: { returnTo: undefined, error: undefined } })
  }

  return (
    <header
      className="mobile-topbar"
      style={{
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        background: 'var(--color-bg-sunken)',
        borderBottom: '1px solid var(--color-line)',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: 7,
          background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-violet) 100%)',
          display: 'grid',
          placeItems: 'center',
          color: 'white',
          fontWeight: 800,
          fontSize: 13,
          letterSpacing: '-0.02em',
          boxShadow: 'var(--shadow-sm), inset 0 1px 0 rgba(255,255,255,0.25)',
          flexShrink: 0,
        }}
      >
        F
      </div>
      <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: '-0.01em' }}>Fumireply</span>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
        <LanguageToggle />
        <button
          onClick={handleLogout}
          aria-label={m.nav_logout()}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 8,
            borderRadius: 8,
            color: 'var(--color-ink-3)',
            cursor: 'pointer',
          }}
        >
          <LogOutIcon size={16} />
        </button>
      </div>
    </header>
  )
}

function MobileBottomNav() {
  const location = useLocation()

  return (
    <nav
      className="mobile-bottomnav"
      style={{
        flexShrink: 0,
        background: 'var(--color-bg-sunken)',
        borderTop: '1px solid var(--color-line)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon
        const isDisabled = item.href === '#'
        const isActive = !isDisabled && location.pathname.startsWith(item.href)
        const sharedStyle = {
          display: 'flex',
          flexDirection: 'column' as const,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 3,
          flex: 1,
          padding: '8px 0',
          fontSize: 10.5,
          fontWeight: isActive ? 600 : 500,
          color: isActive ? 'var(--color-primary)' : 'var(--color-ink-3)',
          textDecoration: 'none',
          opacity: isDisabled ? 0.4 : 1,
        }

        if (isDisabled) {
          return (
            <span key={item.key} aria-disabled="true" style={sharedStyle}>
              <Icon size={19} />
              <span>{item.label()}</span>
            </span>
          )
        }

        return (
          <Link key={item.key} to={item.href as NavHref} style={sharedStyle}>
            <Icon size={19} />
            <span>{item.label()}</span>
          </Link>
        )
      })}
    </nav>
  )
}
