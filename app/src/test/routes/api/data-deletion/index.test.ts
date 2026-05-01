import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'

// vi.mock is hoisted — use vi.hoisted() so factory functions can reference these mocks
const { mockSsmSend, mockDeleteUserData } = vi.hoisted(() => ({
  mockSsmSend: vi.fn(),
  mockDeleteUserData: vi.fn(),
}))

vi.mock('@aws-sdk/client-ssm', () => ({
  // Regular (non-arrow) function so `new SSMClient()` works as a constructor
  SSMClient: vi.fn().mockImplementation(function (this: { send: unknown }) {
    this.send = mockSsmSend
  }),
  GetParameterCommand: vi.fn().mockImplementation(function (
    this: unknown,
    input: { Name: string },
  ) {
    return { Name: input.Name }
  }),
}))

vi.mock('~/routes/api/data-deletion/-lib/delete-user-data', () => ({
  deleteUserData: mockDeleteUserData,
}))

// ---------------------------------------------------------------------------

const TEST_APP_SECRET = 'test-app-secret-abc'
const TEST_HASH_SALT = 'test-hash-salt-xyz'
const TEST_PSID = 'psid_67890'
const TEST_CODE = 'abcdef1234567890abcdef1234567890'

function buildSignedRequest(psid: string, appSecret: string): string {
  const payload = JSON.stringify({
    algorithm: 'HMAC-SHA256',
    issued_at: Math.floor(Date.now() / 1000),
    user_id: psid,
  })
  const payloadB64 = Buffer.from(payload).toString('base64url')
  const sig = createHmac('sha256', appSecret).update(payloadB64).digest()
  const sigB64 = Buffer.from(sig).toString('base64url')
  return `${sigB64}.${payloadB64}`
}

function buildPostRequest(signedRequest: string): Request {
  const body = new URLSearchParams({ signed_request: signedRequest }).toString()
  return new Request('http://localhost/api/data-deletion/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
}

// Import handler after mocks are in place
const { handleDataDeletion } = await import('~/routes/api/data-deletion/index')

beforeEach(() => {
  // Use mockReset() rather than vi.clearAllMocks() so the "once" queues are
  // fully flushed between tests (clearAllMocks only clears call history).
  mockSsmSend.mockReset()
  mockDeleteUserData.mockReset()

  vi.stubEnv('META_APP_SECRET_SSM_KEY', '/fumireply/review/meta/app-secret')
  vi.stubEnv('DELETION_LOG_HASH_SALT_SSM_KEY', '/fumireply/review/deletion-log/hash-salt')
  vi.stubEnv('AWS_REGION', 'ap-northeast-1')

  // First SSM call → app secret, second → hash salt
  mockSsmSend
    .mockResolvedValueOnce({ Parameter: { Value: TEST_APP_SECRET } })
    .mockResolvedValueOnce({ Parameter: { Value: TEST_HASH_SALT } })

  mockDeleteUserData.mockResolvedValue({ confirmationCode: TEST_CODE })
})

describe('POST /api/data-deletion/ (handleDataDeletion)', () => {
  it('returns 200 with url and confirmation_code for valid signed_request', async () => {
    const sr = buildSignedRequest(TEST_PSID, TEST_APP_SECRET)
    const response = await handleDataDeletion(buildPostRequest(sr))

    expect(response.status).toBe(200)
    const body = (await response.json()) as { url: string; confirmation_code: string }
    expect(body.confirmation_code).toBe(TEST_CODE)
    expect(body.url).toContain(TEST_CODE)
    expect(body.url).toContain('/data-deletion-status/')
    expect(mockDeleteUserData).toHaveBeenCalledWith(TEST_PSID, TEST_HASH_SALT)
  })

  it('returns 400 for invalid signature (wrong secret)', async () => {
    const sr = buildSignedRequest(TEST_PSID, 'wrong-secret')
    // SSM still returns the correct app secret, but the signed request used a different key
    const response = await handleDataDeletion(buildPostRequest(sr))

    expect(response.status).toBe(400)
    expect(mockDeleteUserData).not.toHaveBeenCalled()
  })

  it('returns 400 when signed_request field is absent', async () => {
    const body = new URLSearchParams({ other_field: 'value' }).toString()
    const request = new Request('http://localhost/api/data-deletion/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    const response = await handleDataDeletion(request)

    expect(response.status).toBe(400)
    expect(mockDeleteUserData).not.toHaveBeenCalled()
  })

  it('returns 500 on database error', async () => {
    mockDeleteUserData.mockRejectedValueOnce(new Error('DB connection failed'))
    const sr = buildSignedRequest(TEST_PSID, TEST_APP_SECRET)
    const response = await handleDataDeletion(buildPostRequest(sr))

    expect(response.status).toBe(500)
  })

  it('returns 500 when META_APP_SECRET_SSM_KEY env var is missing', async () => {
    vi.stubEnv('META_APP_SECRET_SSM_KEY', '')
    const sr = buildSignedRequest(TEST_PSID, TEST_APP_SECRET)
    const response = await handleDataDeletion(buildPostRequest(sr))

    expect(response.status).toBe(500)
    expect(mockDeleteUserData).not.toHaveBeenCalled()
  })
})
