import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderRoute } from '~/test/file-route-utils'
import { Route } from '~/routes/(public)/data-deletion'

const DataDeletionPage = Route.options.component as () => ReactNode

describe('(public)/data-deletion route', () => {
  it('renders the data deletion heading', async () => {
    renderRoute({ path: '/data-deletion', component: DataDeletionPage, initialEntries: ['/data-deletion'] })

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('ユーザーデータ削除')
    })
  })

  it('lists ai_drafts as a deletion target (FR-014)', async () => {
    renderRoute({ path: '/data-deletion', component: DataDeletionPage, initialEntries: ['/data-deletion'] })

    await waitFor(() => {
      expect(screen.getByText(/ai_drafts/)).toBeInTheDocument()
    })
  })

  it('provides a manual email deletion method (FR-014)', async () => {
    renderRoute({ path: '/data-deletion', component: DataDeletionPage, initialEntries: ['/data-deletion'] })

    await waitFor(() => {
      expect(screen.getByText(/メールによる手動依頼/)).toBeInTheDocument()
      expect(screen.getByRole('link', { name: /malbek\.co\.jp/ })).toBeInTheDocument()
    })
  })

  it('renders navigation links to other public pages', async () => {
    renderRoute({ path: '/data-deletion', component: DataDeletionPage, initialEntries: ['/data-deletion'] })

    await waitFor(() => {
      expect(screen.getAllByRole('link', { name: '会社情報' }).length).toBeGreaterThan(0)
      expect(screen.getAllByRole('link', { name: 'プライバシーポリシー' }).length).toBeGreaterThan(0)
      expect(screen.getAllByRole('link', { name: '利用規約' }).length).toBeGreaterThan(0)
    })
  })
})
