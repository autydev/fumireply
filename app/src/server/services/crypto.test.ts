import { describe, expect, it, vi, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'

vi.mock('./ssm', () => ({
  getSsmParameter: vi.fn(),
}))

vi.mock('../db/client', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(),
  },
}))

const { getSsmParameter } = await import('./ssm')
const { encryptToken, decryptToken, getMasterKey, clearMasterKeyCache } = await import('./crypto')

const TEST_MASTER_KEY = randomBytes(32)
const TEST_MASTER_KEY_HEX = TEST_MASTER_KEY.toString('hex')

describe('encryptToken / decryptToken', () => {
  it('round-trips plaintext correctly', () => {
    const plaintext = 'EAABcde12345_page_access_token'
    const blob = encryptToken(plaintext, TEST_MASTER_KEY)
    const result = decryptToken(blob, TEST_MASTER_KEY)
    expect(result).toBe(plaintext)
  })

  it('produces different ciphertext each call (random IV)', () => {
    const plaintext = 'same-token'
    const blob1 = encryptToken(plaintext, TEST_MASTER_KEY)
    const blob2 = encryptToken(plaintext, TEST_MASTER_KEY)
    expect(blob1.equals(blob2)).toBe(false)
  })

  it('fails decryption when auth tag is tampered', () => {
    const blob = encryptToken('test-token', TEST_MASTER_KEY)
    // Corrupt the auth tag (bytes 12-27)
    blob[15] ^= 0xff
    expect(() => decryptToken(blob, TEST_MASTER_KEY)).toThrow()
  })

  it('fails decryption when wrong key is used', () => {
    const blob = encryptToken('test-token', TEST_MASTER_KEY)
    const wrongKey = randomBytes(32)
    expect(() => decryptToken(blob, wrongKey)).toThrow()
  })

  it('throws on blob too short', () => {
    expect(() => decryptToken(Buffer.alloc(10), TEST_MASTER_KEY)).toThrow('Invalid encrypted blob')
  })
})

describe('getMasterKey', () => {
  beforeEach(() => {
    clearMasterKeyCache()
    vi.mocked(getSsmParameter).mockReset()
  })

  it('fetches from SSM and returns Buffer', async () => {
    vi.mocked(getSsmParameter).mockResolvedValueOnce(TEST_MASTER_KEY_HEX)
    const key = await getMasterKey()
    expect(key).toBeInstanceOf(Buffer)
    expect(key.length).toBe(32)
  })

  it('caches the master key (SSM called only once)', async () => {
    vi.mocked(getSsmParameter).mockResolvedValueOnce(TEST_MASTER_KEY_HEX)
    await getMasterKey()
    await getMasterKey()
    expect(getSsmParameter).toHaveBeenCalledTimes(1)
  })
})
