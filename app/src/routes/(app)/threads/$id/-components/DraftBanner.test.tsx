import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'

const CONVERSATION_ID = '11111111-1111-4111-9111-111111111111'

type DraftStatusResult = { status: string; body: string | null; error: string | null }

const { mockGetDraftStatus } = vi.hoisted(() => ({
  mockGetDraftStatus: vi.fn<(arg?: unknown) => Promise<DraftStatusResult>>(),
}))

vi.mock('../-lib/get-draft-status.fn', () => ({
  getDraftStatusFn: (args: { data: unknown }) => mockGetDraftStatus(args.data),
}))

const { DraftBanner } = await import('./DraftBanner')

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('DraftBanner (005)', () => {
  it('renders nothing when initialStatus is ready', () => {
    render(
      <DraftBanner
        conversationId={CONVERSATION_ID}
        initialStatus="ready"
        onReady={() => {}}
      />,
    )
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows pending banner and calls onReady when polling returns ready+no error', async () => {
    mockGetDraftStatus.mockResolvedValue({
      status: 'ready',
      body: 'NEW BODY',
      error: null,
    })
    const onReady = vi.fn()
    render(
      <DraftBanner
        conversationId={CONVERSATION_ID}
        initialStatus="pending"
        onReady={onReady}
      />,
    )
    expect(screen.getByRole('status')).toBeInTheDocument()

    // Advance past the first poll interval (3s) and flush microtasks.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500)
    })

    expect(onReady).toHaveBeenCalledWith('NEW BODY')
  })

  it('calls onError("regenerate_failed", message) when ready+error from server', async () => {
    mockGetDraftStatus.mockResolvedValue({
      status: 'ready',
      body: 'OLD BODY',
      error: 'auth_failed',
    })
    const onReady = vi.fn()
    const onError = vi.fn()
    render(
      <DraftBanner
        conversationId={CONVERSATION_ID}
        initialStatus="pending"
        mode="regenerate"
        onReady={onReady}
        onError={onError}
      />,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500)
    })

    expect(onError).toHaveBeenCalledWith('regenerate_failed', 'auth_failed')
    expect(onReady).not.toHaveBeenCalled()
  })

  it('mode="regenerate" fires onError("timeout") after 90s', async () => {
    // Status stays pending so we hit the timeout branch.
    mockGetDraftStatus.mockResolvedValue({ status: 'pending', body: null, error: null })
    const onError = vi.fn()
    render(
      <DraftBanner
        conversationId={CONVERSATION_ID}
        initialStatus="pending"
        mode="regenerate"
        onReady={() => {}}
        onError={onError}
      />,
    )

    // Advance past 90s, then one more poll interval (3s) so the next poll
    // observes Date.now() - startTime > 90_000.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(94_000)
    })

    expect(onError).toHaveBeenCalledWith('timeout')
  })

  it('mode="auto" (default) stops polling at 60s, contract differs from 90s regen mode', async () => {
    mockGetDraftStatus.mockResolvedValue({ status: 'pending', body: null, error: null })
    const onError = vi.fn()
    render(
      <DraftBanner
        conversationId={CONVERSATION_ID}
        initialStatus="pending"
        // mode defaults to 'auto'
        onReady={() => {}}
        onError={onError}
      />,
    )

    // Before 60s: not yet timed out (use async timer advance so the in-flight
    // poll's promise resolves before we assert).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000)
    })
    expect(onError).not.toHaveBeenCalled()

    // Past 60s: auto-batch timeout fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })
    expect(onError).toHaveBeenCalledWith('timeout')
  })
})
