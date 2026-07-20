// #84: custom_prompt saves must not fail silently — a failed save shows the
// error badge with a retry button, and retry re-sends the latest value.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('~/routes/(app)/settings/-lib/update-page-prompt.fn', () => ({
  updatePagePromptFn: vi.fn(),
}))

import { updatePagePromptFn } from '~/routes/(app)/settings/-lib/update-page-prompt.fn'
import { PageCustomPromptEditor } from '~/routes/(app)/settings/-components/PageCustomPromptEditor'

const PAGE_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('PageCustomPromptEditor save feedback (#84)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows 保存済み after a successful debounced save', async () => {
    vi.mocked(updatePagePromptFn).mockResolvedValue({
      ok: true,
      updatedAt: new Date().toISOString(),
    })

    render(
      <PageCustomPromptEditor
        connectedPageId={PAGE_UUID}
        pageName="Test Page"
        customPrompt={null}
      />,
    )

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Ship within 3 days' },
    })

    await waitFor(
      () => {
        expect(vi.mocked(updatePagePromptFn)).toHaveBeenCalledWith({
          data: { connectedPageId: PAGE_UUID, customPrompt: 'Ship within 3 days' },
        })
        expect(screen.getByText('保存済み')).toBeInTheDocument()
      },
      { timeout: 3000 },
    )
  })

  it('surfaces a failed save with 保存に失敗しました + 再試行, retry re-saves the latest value', async () => {
    vi.mocked(updatePagePromptFn).mockRejectedValueOnce(new Error('network'))

    render(
      <PageCustomPromptEditor
        connectedPageId={PAGE_UUID}
        pageName="Test Page"
        customPrompt={null}
      />,
    )

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Policy that fails to save' },
    })

    await waitFor(
      () => {
        expect(screen.getByRole('alert')).toHaveTextContent('保存に失敗しました')
      },
      { timeout: 3000 },
    )

    vi.mocked(updatePagePromptFn).mockResolvedValueOnce({
      ok: true,
      updatedAt: new Date().toISOString(),
    })
    fireEvent.click(screen.getByRole('button', { name: '再試行' }))

    await waitFor(() => {
      expect(screen.getByText('保存済み')).toBeInTheDocument()
    })
    expect(vi.mocked(updatePagePromptFn)).toHaveBeenLastCalledWith({
      data: { connectedPageId: PAGE_UUID, customPrompt: 'Policy that fails to save' },
    })
  })
})
