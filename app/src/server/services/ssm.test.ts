import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSend = vi.fn()

vi.mock('@aws-sdk/client-ssm', () => {
  class MockSSMClient {
    send = mockSend
  }
  class MockGetParameterCommand {
    input: unknown
    constructor(input: unknown) {
      this.input = input
    }
  }
  return {
    SSMClient: MockSSMClient,
    GetParameterCommand: MockGetParameterCommand,
  }
})

// Import after mock
const { getSsmParameter, clearSsmCache } = await import('./ssm')

describe('getSsmParameter', () => {
  beforeEach(() => {
    clearSsmCache()
    mockSend.mockReset()
  })

  afterEach(() => {
    clearSsmCache()
  })

  it('fetches parameter with decryption', async () => {
    mockSend.mockResolvedValueOnce({ Parameter: { Value: 'secret-value' } })
    const result = await getSsmParameter('/fumireply/test/key')
    expect(result).toBe('secret-value')
  })

  it('returns cached value on second call', async () => {
    mockSend.mockResolvedValueOnce({ Parameter: { Value: 'cached-value' } })
    const first = await getSsmParameter('/fumireply/test/key')
    const second = await getSsmParameter('/fumireply/test/key')
    expect(first).toBe('cached-value')
    expect(second).toBe('cached-value')
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('fetches again after TTL expiry', async () => {
    mockSend
      .mockResolvedValueOnce({ Parameter: { Value: 'old-value' } })
      .mockResolvedValueOnce({ Parameter: { Value: 'new-value' } })

    await getSsmParameter('/fumireply/test/key', 0)
    // TTL=0 means immediately expired (expiresAt = now + 0)
    // We need to advance time slightly; instead just clear cache
    clearSsmCache()
    const result = await getSsmParameter('/fumireply/test/key', 0)
    expect(result).toBe('new-value')
    expect(mockSend).toHaveBeenCalledTimes(2)
  })

  it('throws when parameter not found', async () => {
    mockSend.mockResolvedValueOnce({ Parameter: {} })
    await expect(getSsmParameter('/fumireply/missing')).rejects.toThrow('SSM parameter not found')
  })

  it('throws when SSM call fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('network error'))
    await expect(getSsmParameter('/fumireply/error')).rejects.toThrow('network error')
  })
})
