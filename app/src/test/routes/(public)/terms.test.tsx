import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderRoute } from '~/test/file-route-utils'
import { Route } from '~/routes/(public)/terms'

const TermsPage = Route.options.component as () => ReactNode

describe('(public)/terms route', () => {
  it('renders the terms of service heading', async () => {
    renderRoute({ path: '/terms', component: TermsPage, initialEntries: ['/terms'] })

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('利用規約')
    })
  })

  it('covers required legal sections (FR-013)', async () => {
    renderRoute({ path: '/terms', component: TermsPage, initialEntries: ['/terms'] })

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /禁止事項/ })).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: /免責事項/ })).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: /準拠法/ })).toBeInTheDocument()
    })
  })

  it('specifies the governing court jurisdiction (FR-013)', async () => {
    renderRoute({ path: '/terms', component: TermsPage, initialEntries: ['/terms'] })

    await waitFor(() => {
      expect(screen.getByText(/岐阜地方裁判所/)).toBeInTheDocument()
    })
  })

  it('renders navigation links to other public pages', async () => {
    renderRoute({ path: '/terms', component: TermsPage, initialEntries: ['/terms'] })

    await waitFor(() => {
      expect(screen.getByRole('link', { name: '会社情報' })).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'プライバシーポリシー' })).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'データ削除' })).toBeInTheDocument()
    })
  })
})
