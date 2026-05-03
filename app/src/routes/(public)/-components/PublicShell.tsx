import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'

type Props = {
  children: ReactNode
}

const NAV = [
  { href: '/', label: '会社情報' },
  { href: '/privacy', label: 'プライバシーポリシー' },
  { href: '/terms', label: '利用規約' },
  { href: '/data-deletion', label: 'データ削除' },
]

export function PublicShell({ children }: Props) {
  const year = new Date().getFullYear()
  return (
    <>
      <header className="public-header">
        <div className="public-header__inner">
          <Link to="/" className="public-header__brand">
            <span className="public-header__mark" aria-hidden="true">F</span>
            <span className="public-header__title">Fumireply</span>
          </Link>
          <nav className="public-header__nav" aria-label="サイトナビゲーション">
            {NAV.map((item) => (
              <Link key={item.href} to={item.href}>
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      {children}

      <footer className="public-footer">
        <div className="public-footer__inner">
          <nav className="public-footer__nav" aria-label="フッターナビゲーション">
            {NAV.map((item) => (
              <Link key={item.href} to={item.href}>
                {item.label}
              </Link>
            ))}
          </nav>
          <span className="public-footer__copyright">
            © {year} 株式会社Malbek
          </span>
        </div>
      </footer>
    </>
  )
}
