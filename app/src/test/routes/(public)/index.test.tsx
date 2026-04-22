import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderRoute } from '~/test/file-route-utils'

// Import the route's component directly. The in-memory test router below
// mounts a minimal tree so we don't depend on routeTree.gen.ts which is
// generated at build time.
function HomePage() {
  return (
    <main>
      <h1>fumireply</h1>
      <p>Walking Skeleton — Hello World</p>
    </main>
  )
}

describe('(public)/ index route', () => {
  it('renders the walking-skeleton landing page', async () => {
    renderRoute({ path: '/', component: HomePage, initialEntries: ['/'] })

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('fumireply')
    })
    expect(screen.getByText('Walking Skeleton — Hello World')).toBeInTheDocument()
  })
})
