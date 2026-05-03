import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderRoute } from '~/test/file-route-utils'
import { Route } from '~/routes/(public)/privacy'

const PrivacyPage = Route.options.component as () => ReactNode

describe('(public)/privacy route', () => {
  it('renders the privacy policy heading', async () => {
    renderRoute({ path: '/privacy', component: PrivacyPage, initialEntries: ['/privacy'] })

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('プライバシーポリシー')
    })
  })

  it('explicitly names Anthropic as a third-party data recipient (FR-012)', async () => {
    renderRoute({ path: '/privacy', component: PrivacyPage, initialEntries: ['/privacy'] })

    await waitFor(() => {
      expect(screen.getByText('Anthropic, Inc.（米国）')).toBeInTheDocument()
    })
  })

  it('covers all required data sections (FR-012)', async () => {
    renderRoute({ path: '/privacy', component: PrivacyPage, initialEntries: ['/privacy'] })

    await waitFor(() => {
      expect(screen.getByText(/取得するデータ項目/)).toBeInTheDocument()
      expect(screen.getByText(/利用目的/)).toBeInTheDocument()
      expect(screen.getByText(/第三者へのデータ提供/)).toBeInTheDocument()
      expect(screen.getByText(/データ削除の依頼/)).toBeInTheDocument()
    })
  })

  it('renders navigation links to other public pages', async () => {
    renderRoute({ path: '/privacy', component: PrivacyPage, initialEntries: ['/privacy'] })

    await waitFor(() => {
      expect(screen.getAllByRole('link', { name: '会社情報' }).length).toBeGreaterThan(0)
      expect(screen.getAllByRole('link', { name: '利用規約' }).length).toBeGreaterThan(0)
      expect(screen.getAllByRole('link', { name: 'データ削除' }).length).toBeGreaterThan(0)
    })
  })
})
