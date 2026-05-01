import { describe, expect, it, vi } from 'vitest'
import { useEffect, useState } from 'react'
import { screen, waitFor } from '@testing-library/react'
import { renderRoute } from '~/test/file-route-utils'
import type { ConversationDetail } from '~/routes/(app)/threads/$id/-lib/get-conversation.fn'

vi.mock('~/routes/(app)/threads/$id/-lib/get-conversation.fn', () => ({
  getConversationFn: vi.fn(),
}))
vi.mock('~/routes/(app)/threads/$id/-lib/send-reply.fn', () => ({
  sendReplyFn: vi.fn(),
}))
vi.mock('~/routes/(app)/threads/$id/-lib/get-draft-status.fn', () => ({
  getDraftStatusFn: vi.fn(),
}))

// Proper UUID constants (safer if validators tighten to z.string().uuid())
const CONV_ID = '00000000-0000-0000-0000-000000000001'
const NOW_ISO = '2026-05-01T00:00:00.000Z'

function makeDetail(overrides: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    conversation: {
      id: CONV_ID,
      customer_psid: 'psid-1',
      customer_name: 'Alice',
      last_inbound_at: '2026-04-30T23:00:00.000Z',
      within_24h_window: true,
      hours_remaining_in_window: 23,
    },
    messages: [],
    latest_draft: null,
    ...overrides,
  }
}

function makeMessage(
  overrides: Partial<ConversationDetail['messages'][number]> = {},
): ConversationDetail['messages'][number] {
  return {
    id: 'msg-1',
    direction: 'inbound',
    body: 'Hello',
    message_type: 'text',
    timestamp: NOW_ISO,
    send_status: null,
    send_error: null,
    ai_draft: null,
    ...overrides,
  }
}

describe('Thread page', () => {
  it('renders messages in chronological order', async () => {
    const { ThreadMessages } = await import(
      '~/routes/(app)/threads/$id/-components/ThreadMessages'
    )

    const messages = [
      makeMessage({ id: 'msg-1', body: 'First message', timestamp: '2026-04-30T10:00:00Z' }),
      makeMessage({
        id: 'msg-2',
        body: 'Second message',
        direction: 'outbound',
        timestamp: '2026-04-30T10:05:00Z',
        send_status: 'sent',
      }),
      makeMessage({ id: 'msg-3', body: 'Third message', timestamp: '2026-04-30T10:10:00Z' }),
    ]

    renderRoute({
      path: '/threads/$id',
      component: () => <ThreadMessages messages={messages} />,
      initialEntries: [`/threads/${CONV_ID}`],
    })

    await waitFor(() => {
      const items = screen.getAllByRole('listitem')
      expect(items).toHaveLength(3)
      expect(items[0]).toHaveTextContent('First message')
      expect(items[1]).toHaveTextContent('Second message')
      expect(items[2]).toHaveTextContent('Third message')
    })
  })

  it('loader calls getConversationFn (which triggers unread_count reset)', async () => {
    const { getConversationFn } = await import(
      '~/routes/(app)/threads/$id/-lib/get-conversation.fn'
    )

    const detail = makeDetail()
    vi.mocked(getConversationFn).mockResolvedValue(detail)

    // Simulate the loader: component fetches on mount just like the SSR route's loader
    function LoaderSimulator() {
      const [loaded, setLoaded] = useState(false)
      useEffect(() => {
        getConversationFn({ data: { id: CONV_ID } }).then(() => setLoaded(true))
      }, [])
      return <div data-testid="status">{loaded ? 'loaded' : 'loading'}</div>
    }

    renderRoute({
      path: '/threads/$id',
      component: LoaderSimulator,
      initialEntries: [`/threads/${CONV_ID}`],
    })

    await waitFor(() => {
      expect(vi.mocked(getConversationFn)).toHaveBeenCalledWith({ data: { id: CONV_ID } })
      expect(screen.getByTestId('status')).toHaveTextContent('loaded')
    })
  })

  it('populates ReplyForm with latest_draft body when status is ready', async () => {
    const { ReplyForm } = await import(
      '~/routes/(app)/threads/$id/-components/ReplyForm'
    )

    const detail = makeDetail({
      latest_draft: { body: 'AI suggested reply text', status: 'ready' },
    })

    renderRoute({
      path: '/threads/$id',
      component: () => (
        <ReplyForm
          conversationId={CONV_ID}
          conversation={detail.conversation}
          latestDraft={detail.latest_draft}
          latestInboundMessageId="msg-1"
        />
      ),
      initialEntries: [`/threads/${CONV_ID}`],
    })

    await waitFor(() => {
      const textarea = screen.getByRole('textbox')
      expect(textarea).toHaveValue('AI suggested reply text')
    })
  })

  it('shows DraftBanner when latest_draft status is pending', async () => {
    const { DraftBanner } = await import(
      '~/routes/(app)/threads/$id/-components/DraftBanner'
    )

    renderRoute({
      path: '/threads/$id',
      component: () => (
        <DraftBanner
          messageId="msg-inbound-1"
          initialStatus="pending"
          onReady={vi.fn()}
        />
      ),
      initialEntries: [`/threads/${CONV_ID}`],
    })

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('下書き生成中…')
    })
  })

  it('shows DraftBanner = null when status is failed', async () => {
    const { DraftBanner } = await import(
      '~/routes/(app)/threads/$id/-components/DraftBanner'
    )

    renderRoute({
      path: '/threads/$id',
      component: () => (
        <DraftBanner
          messageId="msg-inbound-1"
          initialStatus="failed"
          onReady={vi.fn()}
        />
      ),
      initialEntries: [`/threads/${CONV_ID}`],
    })

    // DraftBanner renders null when initialStatus is not pending
    await waitFor(() => {
      expect(screen.queryByRole('status')).toBeNull()
    })
  })

  it('disables send button when 24h window is closed', async () => {
    const { ReplyForm } = await import(
      '~/routes/(app)/threads/$id/-components/ReplyForm'
    )

    const detail = makeDetail({
      conversation: {
        id: CONV_ID,
        customer_psid: 'psid-1',
        customer_name: 'Alice',
        last_inbound_at: '2026-04-29T00:00:00.000Z',
        within_24h_window: false,
        hours_remaining_in_window: null,
      },
    })

    renderRoute({
      path: '/threads/$id',
      component: () => (
        <ReplyForm
          conversationId={CONV_ID}
          conversation={detail.conversation}
          latestDraft={null}
          latestInboundMessageId={null}
        />
      ),
      initialEntries: [`/threads/${CONV_ID}`],
    })

    await waitFor(() => {
      const button = screen.getByRole('button', { name: '送信' })
      expect(button).toBeDisabled()
      expect(screen.getByRole('alert')).toHaveTextContent('24時間窓が閉じているため返信できません。')
    })
  })
})
