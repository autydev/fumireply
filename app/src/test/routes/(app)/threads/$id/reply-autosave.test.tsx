// #83: the reply-form auto-save badge must reflect real persistence — edits are
// saved to the active draft via saveDraftBodyFn, and failures surface with a
// retry button (#84) instead of silently pretending the save succeeded.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderRoute } from '~/test/file-route-utils'
import type { ConversationDetail } from '~/routes/(app)/threads/$id/-lib/get-conversation.fn'

vi.mock('~/routes/(app)/threads/$id/-lib/save-draft-body.fn', () => ({
  saveDraftBodyFn: vi.fn(),
}))
vi.mock('~/routes/(app)/threads/$id/-lib/send-reply.fn', () => ({
  sendReplyFn: vi.fn(),
}))
vi.mock('~/routes/(app)/threads/$id/-lib/dismiss-draft.fn', () => ({
  dismissDraftFn: vi.fn(),
}))
vi.mock('~/routes/(app)/threads/$id/-lib/regenerate-draft.fn', () => ({
  regenerateDraftFn: vi.fn(),
}))
vi.mock('~/routes/(app)/threads/$id/-lib/get-draft-status.fn', () => ({
  getDraftStatusFn: vi.fn(),
}))

import { saveDraftBodyFn } from '~/routes/(app)/threads/$id/-lib/save-draft-body.fn'

const CONV_ID = '00000000-0000-0000-0000-000000000001'

function makeConversation(): ConversationDetail['conversation'] {
  return {
    id: CONV_ID,
    customer_psid: 'psid-1',
    customer_name: 'Alice',
    last_inbound_at: '2026-04-30T23:00:00.000Z',
    within_24h_window: true,
    hours_remaining_in_window: 23,
    summary: null,
    last_summarized_at: null,
    tone_preset: null,
    custom_prompt: null,
    note: null,
  }
}

async function renderReplyForm(latestDraft: ConversationDetail['latest_draft']) {
  const { ReplyForm } = await import(
    '~/routes/(app)/threads/$id/-components/ReplyForm'
  )
  renderRoute({
    path: '/threads/$id',
    component: () => (
      <ReplyForm
        conversationId={CONV_ID}
        conversation={makeConversation()}
        latestDraft={latestDraft}
        latestInboundMessageId="msg-1"
      />
    ),
    initialEntries: [`/threads/${CONV_ID}`],
  })
  await waitFor(() => {
    expect(screen.getByRole('textbox', { name: '返信本文' })).toBeInTheDocument()
  })
}

describe('ReplyForm auto-save (#83/#84)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('persists edits to the draft via saveDraftBodyFn and shows 保存済み', async () => {
    vi.mocked(saveDraftBodyFn).mockResolvedValue({ ok: true, saved: true })
    await renderReplyForm({ body: 'AI draft', status: 'ready' })

    const textarea = screen.getByRole('textbox', { name: '返信本文' })
    fireEvent.change(textarea, { target: { value: 'Edited by operator' } })

    await waitFor(
      () => {
        expect(vi.mocked(saveDraftBodyFn)).toHaveBeenCalledWith({
          data: { conversationId: CONV_ID, body: 'Edited by operator' },
        })
      },
      { timeout: 3000 },
    )
    await waitFor(() => {
      expect(screen.getByText('保存済み')).toBeInTheDocument()
    })
  })

  it('shows 保存に失敗しました + 再試行 on failure, and retry re-saves', async () => {
    vi.mocked(saveDraftBodyFn).mockRejectedValueOnce(new Error('network'))
    await renderReplyForm({ body: 'AI draft', status: 'ready' })

    const textarea = screen.getByRole('textbox', { name: '返信本文' })
    fireEvent.change(textarea, { target: { value: 'Edited then fails' } })

    await waitFor(
      () => {
        expect(screen.getByRole('alert')).toHaveTextContent('保存に失敗しました')
      },
      { timeout: 3000 },
    )

    vi.mocked(saveDraftBodyFn).mockResolvedValueOnce({ ok: true, saved: true })
    fireEvent.click(screen.getByRole('button', { name: '再試行' }))

    await waitFor(() => {
      expect(screen.getByText('保存済み')).toBeInTheDocument()
    })
    expect(vi.mocked(saveDraftBodyFn)).toHaveBeenCalledTimes(2)
  })

  it('does NOT show 保存済み when the server reports saved:false (no ready draft to write)', async () => {
    vi.mocked(saveDraftBodyFn).mockResolvedValue({ ok: true, saved: false })
    await renderReplyForm({ body: 'AI draft', status: 'ready' })

    const textarea = screen.getByRole('textbox', { name: '返信本文' })
    fireEvent.change(textarea, { target: { value: 'Edited but nothing persisted' } })

    await waitFor(
      () => {
        expect(vi.mocked(saveDraftBodyFn)).toHaveBeenCalled()
      },
      { timeout: 3000 },
    )
    // The save resolved but persisted nothing — the badge must not claim 保存済み.
    await waitFor(() => {
      expect(screen.queryByText('保存済み')).toBeNull()
    })
  })

  it('does not call saveDraftBodyFn when there is no active draft', async () => {
    await renderReplyForm(null)

    const textarea = screen.getByRole('textbox', { name: '返信本文' })
    fireEvent.change(textarea, { target: { value: 'Typed from scratch' } })

    // Debounce is 600ms — wait past it and assert no save fired.
    await new Promise((r) => setTimeout(r, 900))
    expect(vi.mocked(saveDraftBodyFn)).not.toHaveBeenCalled()
  })
})
