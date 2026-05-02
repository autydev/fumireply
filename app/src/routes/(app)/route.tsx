import { createFileRoute, Outlet, Link, useRouter, useLocation } from '@tanstack/react-router'
import { TokenStatusBanner } from './-components/TokenStatusBanner'
import { logoutFn } from '~/server/fns/logout.fn'
import {
  InboxIcon,
  UsersIcon,
  PackageIcon,
  SettingsIcon,
  LogOutIcon,
  ChevronDownIcon,
} from '~/components/ui/icons'

export const Route = createFileRoute('/(app)')({
  component: AppLayout,
})

function AppLayout() {
  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--color-bg)', overflow: 'hidden' }}>
      <Sidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <TokenStatusBanner />
        <Outlet />
      </div>
    </div>
  )
}

const NAV_ITEMS = [
  { key: 'inbox', label: '受信トレイ', icon: InboxIcon, href: '/inbox' },
  { key: 'customers', label: '顧客管理', icon: UsersIcon, href: '#' },
  { key: 'products', label: '商品管理', icon: PackageIcon, href: '#' },
  { key: 'settings', label: '設定', icon: SettingsIcon, href: '#' },
]

function Sidebar() {
  const router = useRouter()
  const location = useLocation()

  async function handleLogout() {
    await logoutFn()
    await router.navigate({ to: '/login' })
  }

  return (
    <div
      style={{
        width: 220,
        flexShrink: 0,
        background: 'var(--color-bg-sunken)',
        borderRight: '1px solid var(--color-line)',
        display: 'flex',
        flexDirection: 'column',
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
          M
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, letterSpacing: '-0.01em' }}>Malbek CS</div>
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
                <span>{item.label}</span>
              </span>
            )
          }

          return (
            <Link
              key={item.key}
              to={item.href as '/inbox'}
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
              <span>{item.label}</span>
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
          <span>ログアウト</span>
          <ChevronDownIcon size={12} style={{ marginLeft: 'auto', opacity: 0 }} />
        </button>
      </div>
    </div>
  )
}
