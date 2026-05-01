import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderRoute } from '~/test/file-route-utils'
import { Route } from '~/routes/(public)/index'

const CompanyPage = Route.options.component as () => JSX.Element

describe('(public)/ company info route', () => {
  it('renders the company name heading', async () => {
    renderRoute({ path: '/', component: CompanyPage, initialEntries: ['/'] })

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('株式会社Malbek')
    })
  })

  it('renders required company info fields (FR-015)', async () => {
    renderRoute({ path: '/', component: CompanyPage, initialEntries: ['/'] })

    await waitFor(() => {
      expect(screen.getByText('会社名')).toBeInTheDocument()
      expect(screen.getByText('所在地')).toBeInTheDocument()
      expect(screen.getByText('メールアドレス')).toBeInTheDocument()
      expect(screen.getByText('事業内容')).toBeInTheDocument()
    })
  })

  it('renders navigation links to other public pages', async () => {
    renderRoute({ path: '/', component: CompanyPage, initialEntries: ['/'] })

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'プライバシーポリシー' })).toBeInTheDocument()
      expect(screen.getByRole('link', { name: '利用規約' })).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'データ削除' })).toBeInTheDocument()
    })
  })
})
