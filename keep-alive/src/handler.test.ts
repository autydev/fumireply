import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const DB_URL = 'postgresql://user:pass@host:6543/db'

const mockGetSsmParam = vi.fn<() => Promise<string>>()
const mockPublishSns = vi.fn<() => Promise<void>>()
const mockConnectAndPing = vi.fn<() => Promise<void>>()

async function runWithMocks() {
  const { runKeepalive } = await import('./handler')
  return runKeepalive({
    getSsmParam: mockGetSsmParam,
    publishSns: mockPublishSns,
    connectAndPing: mockConnectAndPing,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  mockGetSsmParam.mockResolvedValue(DB_URL)
  mockPublishSns.mockResolvedValue(undefined)
  mockConnectAndPing.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('keep-alive handler', () => {
  it('succeeds on first attempt without retry', async () => {
    const promise = runWithMocks()
    await vi.runAllTimersAsync()
    await promise
    expect(mockConnectAndPing).toHaveBeenCalledTimes(1)
    expect(mockPublishSns).not.toHaveBeenCalled()
  })

  it('retries on transient failure and succeeds on 3rd attempt', async () => {
    mockConnectAndPing
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(undefined)

    const promise = runWithMocks()
    await vi.runAllTimersAsync()
    await promise

    expect(mockConnectAndPing).toHaveBeenCalledTimes(3)
    expect(mockPublishSns).not.toHaveBeenCalled()
  })

  it('uses exponential backoff: 500ms then 1500ms then 4500ms', async () => {
    const callTimes: number[] = []
    mockConnectAndPing.mockImplementation(() => {
      callTimes.push(Date.now())
      return Promise.reject(new Error('fail'))
    })

    const promise = runWithMocks().catch(() => {})
    await vi.runAllTimersAsync()
    await promise

    expect(callTimes).toHaveLength(4)
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(500)
    expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(1500)
    expect(callTimes[3] - callTimes[2]).toBeGreaterThanOrEqual(4500)
  })

  it('publishes SNS after 3 retries exhausted', async () => {
    mockConnectAndPing.mockRejectedValue(new Error('db unreachable'))

    const promise = runWithMocks().catch(() => {})
    await vi.runAllTimersAsync()
    await promise

    expect(mockPublishSns).toHaveBeenCalledTimes(1)
    expect(mockPublishSns).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Supabase keep-alive 失敗'),
    )
  })

  it('throws after all retries fail so EventBridge can retry', async () => {
    const error = new Error('persistent failure')
    mockConnectAndPing.mockRejectedValue(error)

    const promise = runWithMocks()
    promise.catch(() => {}) // prevent unhandled rejection warning
    await vi.runAllTimersAsync()

    await expect(promise).rejects.toThrow('persistent failure')
  })

  it('makes exactly 4 attempts (1 initial + 3 retries) before giving up', async () => {
    mockConnectAndPing.mockRejectedValue(new Error('fail'))

    const promise = runWithMocks().catch(() => {})
    await vi.runAllTimersAsync()
    await promise

    expect(mockConnectAndPing).toHaveBeenCalledTimes(4)
  })
})
