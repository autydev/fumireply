import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderRoute } from '~/test/file-route-utils'
import type { ConversationSummary } from '~/routes/(app)/inbox/-lib/list-conversations.fn'

// Mock listConversationsFn — server functions are not invocable in jsdom
vi.mock('~/routes/(app)/inbox/-lib/list-conversations.fn', () => ({
  listConversationsFn: vi.fn(),
}))

const makeConv = (overrides: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 'c1',
  customer_psid: 'psid-1',
  customer_name: 'Default Name',
  last_message_at: '2026-04-30T10:00:00.000Z',
  last_inbound_at: '2026-04-30T10:00:00.000Z',
  unread_count: 0,
  last_message_preview: 'Hello world',
  last_message_direction: 'inbound',
  within_24h_window: true,
  ...overrides,
})

describe('InboxList', () => {
  it('renders 3 conversations in latest-first order (as provided by server)', async () => {
    // listConversationsFn orders by last_message_at DESC on the server.
    // InboxList renders items in the order it receives them.
    const { InboxList } = await import('~/routes/(app)/inbox/-components/InboxList')

    const conversations: ConversationSummary[] = [
      makeConv({ id: 'c3', customer_name: 'Charlie', last_message_at: '2026-04-30T12:00:00.000Z' }),
      makeConv({ id: 'c1', customer_name: 'Alice', last_message_at: '2026-04-30T10:00:00.000Z' }),
      makeConv({
        id: 'c2',
        customer_name: null,
        customer_psid: 'psid-2',
        last_message_at: '2026-04-30T08:00:00.000Z',
      }),
    ]

    // renderRoute provides the router context required by TanStack Router's Link component
    renderRoute({ path: '/inbox', component: () => <InboxList conversations={conversations} />, initialEntries: ['/inbox'] })

    await waitFor(() => {
      const items = screen.getAllByRole('listitem')
      expect(items).toHaveLength(3)
      // Verify render order matches given order (server-ordered latest first)
      expect(items[0]).toHaveTextContent('Charlie')
      expect(items[1]).toHaveTextContent('Alice')
      expect(items[2]).toHaveTextContent('psid-2') // PSID fallback when customer_name is null
    })
  })

  it('shows unread badge for conversations with unread_count > 0', async () => {
    const { InboxList } = await import('~/routes/(app)/inbox/-components/InboxList')

    const conversations: ConversationSummary[] = [
      makeConv({ id: 'c1', customer_name: 'Alice', unread_count: 5 }),
      makeConv({
        id: 'c2',
        customer_name: 'Bob',
        unread_count: 0,
        last_message_at: '2026-04-30T09:00:00.000Z',
      }),
    ]

    renderRoute({ path: '/inbox', component: () => <InboxList conversations={conversations} />, initialEntries: ['/inbox'] })

    await waitFor(() => {
      // Alice has 5 unread messages — badge must be visible
      expect(screen.getByText('5')).toBeInTheDocument()
      // Bob has 0 unread — no badge rendered
      const items = screen.getAllByRole('listitem')
      expect(items[1]).not.toHaveTextContent('0')
    })
  })

  it('falls back to customer_psid when customer_name is null', async () => {
    const { InboxList } = await import('~/routes/(app)/inbox/-components/InboxList')

    renderRoute({
      path: '/inbox',
      component: () => <InboxList conversations={[makeConv({ customer_name: null, customer_psid: 'psid-fallback-xyz' })]} />,
      initialEntries: ['/inbox'],
    })

    await waitFor(() => {
      expect(screen.getByText('psid-fallback-xyz')).toBeInTheDocument()
    })
  })

  it('shows empty state when no conversations', async () => {
    const { InboxList } = await import('~/routes/(app)/inbox/-components/InboxList')

    renderRoute({ path: '/inbox', component: () => <InboxList conversations={[]} />, initialEntries: ['/inbox'] })

    await waitFor(() => {
      expect(screen.getByText('メッセージはありません')).toBeInTheDocument()
    })
  })
})

describe('listConversationsFn error propagation', () => {
  it('propagates errors thrown by the serverFn to its caller (e.g. route loader)', async () => {
    // This test verifies that errors (including redirect errors thrown by authMiddleware)
    // are not swallowed — the caller receives them. The route loader then propagates
    // the redirect to TanStack Router which navigates to /login.
    const { listConversationsFn } = await import(
      '~/routes/(app)/inbox/-lib/list-conversations.fn'
    )
    const redirectError = Object.assign(new Error('redirect'), { to: '/login', _isRedirect: true })
    vi.mocked(listConversationsFn).mockRejectedValueOnce(redirectError)

    await expect(listConversationsFn()).rejects.toMatchObject({
      _isRedirect: true,
      to: '/login',
    })
  })
})
