import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

// --- DB mock setup ---------------------------------------------------------

const mockInsertValues = vi.fn().mockResolvedValue([])
const mockInsert = vi.fn(() => ({ values: mockInsertValues }))

const mockDeleteWhere = vi.fn().mockResolvedValue([])
const mockDelete = vi.fn(() => ({ where: mockDeleteWhere }))

// tx.selectDistinct().from().where() chain (now on tx, not dbAdmin)
const mockAdminWhere = vi.fn().mockResolvedValue([])
const mockAdminFrom = vi.fn(() => ({ where: mockAdminWhere }))
const mockAdminSelectDistinct = vi.fn(() => ({ from: mockAdminFrom }))

// tx passed into dbAdmin.transaction
const tx = {
  selectDistinct: mockAdminSelectDistinct,
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
  mockAdminWhere.mockResolvedValue([])
  mockDeleteWhere.mockResolvedValue([])
  mockInsertValues.mockResolvedValue([])
})

describe('deleteUserData', () => {
  it('returns a 32-char confirmationCode even when PSID not found', async () => {
    mockAdminWhere.mockResolvedValueOnce([])

    const result = await deleteUserData(TEST_PSID, HASH_SALT)

    expect(result.confirmationCode).toHaveLength(32)
    // Transaction still runs — selectDistinct is now inside it
    expect(mockAdminTransaction).toHaveBeenCalledTimes(1)
    // But no delete or insert happens
    expect(mockDeleteWhere).not.toHaveBeenCalled()
    expect(mockInsertValues).not.toHaveBeenCalled()
  })

  it('deletes conversations and inserts deletion_log in a single atomic transaction', async () => {
    mockAdminWhere.mockResolvedValueOnce([{ tenantId: TEST_TENANT_ID }])

    const result = await deleteUserData(TEST_PSID, HASH_SALT)

    // Single atomic service-role transaction
    expect(mockAdminTransaction).toHaveBeenCalledTimes(1)

    // conversations DELETE
    expect(mockDelete).toHaveBeenCalledWith(expect.anything())
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1)

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
    mockAdminWhere.mockResolvedValueOnce([
      { tenantId: TEST_TENANT_ID },
      { tenantId: TENANT_B },
    ])

    const result = await deleteUserData(TEST_PSID, HASH_SALT)

    // One transaction for all tenants — truly atomic
    expect(mockAdminTransaction).toHaveBeenCalledTimes(1)
    // Single DELETE with inArray filter covers all tenants
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1)
    // Single deletion_log INSERT
    expect(mockInsertValues).toHaveBeenCalledTimes(1)
    expect(result.confirmationCode).toHaveLength(32)
  })

  it('computes psidHash as sha256(salt+psid)', async () => {
    mockAdminWhere.mockResolvedValueOnce([{ tenantId: TEST_TENANT_ID }])

    await deleteUserData(TEST_PSID, HASH_SALT)

    const expectedHash = createHash('sha256').update(HASH_SALT + TEST_PSID).digest('hex')
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ psidHash: expectedHash }),
    )
  })
})
