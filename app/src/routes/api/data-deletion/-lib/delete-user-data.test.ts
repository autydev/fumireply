import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

// --- DB mock setup ---------------------------------------------------------

const mockInsertValues = vi.fn().mockResolvedValue([])
const mockInsert = vi.fn(() => ({ values: mockInsertValues }))

// tx.delete().where().returning() chain
const mockDeleteReturning = vi.fn().mockResolvedValue([])
const mockDeleteWhere = vi.fn(() => ({ returning: mockDeleteReturning }))
const mockDelete = vi.fn(() => ({ where: mockDeleteWhere }))

// tx passed into dbAdmin.transaction
const tx = {
  delete: mockDelete,
  insert: mockInsert,
}

// dbAdmin.transaction calls fn(tx) and returns its result
const mockAdminTransaction = vi.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx))

const mockDbAdmin = { transaction: mockAdminTransaction }

vi.mock('~/server/db/client', () => ({
  dbAdmin: mockDbAdmin,
}))

// ---------------------------------------------------------------------------

// Import AFTER mocks are registered
const { deleteUserData } = await import('./delete-user-data')

const HASH_SALT = 'test-salt-abc'
const TEST_PSID = 'psid_12345'
const TEST_TENANT_ID = '11111111-1111-1111-1111-111111111111'

beforeEach(() => {
  vi.clearAllMocks()
  mockAdminTransaction.mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx))
  mockDeleteReturning.mockResolvedValue([])
  mockInsertValues.mockResolvedValue([])
})

describe('deleteUserData', () => {
  it('returns a 32-char confirmationCode even when PSID not found', async () => {
    mockDeleteReturning.mockResolvedValueOnce([])

    const result = await deleteUserData(TEST_PSID, HASH_SALT)

    expect(result.confirmationCode).toHaveLength(32)
    // Transaction still runs — DELETE is now the first and only lookup
    expect(mockAdminTransaction).toHaveBeenCalledTimes(1)
    // But no insert happens when nothing was deleted
    expect(mockInsertValues).not.toHaveBeenCalled()
  })

  it('deletes conversations and inserts deletion_log in a single atomic transaction', async () => {
    mockDeleteReturning.mockResolvedValueOnce([{ tenantId: TEST_TENANT_ID }])

    const result = await deleteUserData(TEST_PSID, HASH_SALT)

    // Single atomic service-role transaction
    expect(mockAdminTransaction).toHaveBeenCalledTimes(1)

    // conversations DELETE
    expect(mockDelete).toHaveBeenCalledWith(expect.anything())
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1)
    expect(mockDeleteReturning).toHaveBeenCalledTimes(1)

    // deletion_log INSERT
    expect(mockInsert).toHaveBeenCalledWith(expect.anything())
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TEST_TENANT_ID,
        confirmationCode: result.confirmationCode,
        psidHash: createHash('sha256').update(HASH_SALT + TEST_PSID).digest('hex'),
      }),
    )

    expect(result.confirmationCode).toHaveLength(32)
  })

  it('processes multiple tenants in a single atomic transaction', async () => {
    const TENANT_B = '22222222-2222-2222-2222-222222222222'
    mockDeleteReturning.mockResolvedValueOnce([
      { tenantId: TEST_TENANT_ID },
      { tenantId: TENANT_B },
    ])

    const result = await deleteUserData(TEST_PSID, HASH_SALT)

    // One transaction for all tenants — truly atomic
    expect(mockAdminTransaction).toHaveBeenCalledTimes(1)
    // Single DELETE covers all tenants
    expect(mockDeleteReturning).toHaveBeenCalledTimes(1)
    // Single deletion_log INSERT
    expect(mockInsertValues).toHaveBeenCalledTimes(1)
    expect(result.confirmationCode).toHaveLength(32)
  })

  it('computes psidHash as sha256(salt+psid)', async () => {
    mockDeleteReturning.mockResolvedValueOnce([{ tenantId: TEST_TENANT_ID }])

    await deleteUserData(TEST_PSID, HASH_SALT)

    const expectedHash = createHash('sha256').update(HASH_SALT + TEST_PSID).digest('hex')
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ psidHash: expectedHash }),
    )
  })
})
