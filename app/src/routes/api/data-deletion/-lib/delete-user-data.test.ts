import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

// --- DB mock setup ---------------------------------------------------------

const mockInsertValues = vi.fn().mockResolvedValue([])
const mockInsert = vi.fn(() => ({ values: mockInsertValues }))

const mockDeleteWhere = vi.fn().mockResolvedValue([])
const mockDelete = vi.fn(() => ({ where: mockDeleteWhere }))

const mockExecute = vi.fn().mockResolvedValue(undefined)

// tx passed into withTenant's fn() — anon-role client mock
const tx = {
  execute: mockExecute,
  delete: mockDelete,
  insert: mockInsert,
}

// db.transaction calls fn(tx) and returns its result
const mockDbTransaction = vi.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx))

const mockDb = { transaction: mockDbTransaction }

// dbAdmin.selectDistinct().from().where() chain
const mockAdminWhere = vi.fn().mockResolvedValue([])
const mockAdminFrom = vi.fn(() => ({ where: mockAdminWhere }))
const mockAdminSelectDistinct = vi.fn(() => ({ from: mockAdminFrom }))

const mockDbAdmin = { selectDistinct: mockAdminSelectDistinct }

vi.mock('~/server/db/client', () => ({
  db: mockDb,
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
  mockDbTransaction.mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx))
  mockAdminWhere.mockResolvedValue([])
  mockDeleteWhere.mockResolvedValue([])
  mockInsertValues.mockResolvedValue([])
  mockExecute.mockResolvedValue(undefined)
})

describe('deleteUserData', () => {
  it('returns a 32-char confirmationCode even when PSID not found', async () => {
    mockAdminWhere.mockResolvedValueOnce([])

    const result = await deleteUserData(TEST_PSID, HASH_SALT)

    expect(result.confirmationCode).toHaveLength(32)
    // No transaction should be started — no tenants found
    expect(mockDbTransaction).not.toHaveBeenCalled()
  })

  it('deletes conversations and inserts deletion_log for each matching tenant', async () => {
    mockAdminWhere.mockResolvedValueOnce([{ tenantId: TEST_TENANT_ID }])

    const result = await deleteUserData(TEST_PSID, HASH_SALT)

    // withTenant should have run one transaction
    expect(mockDbTransaction).toHaveBeenCalledTimes(1)

    // SET LOCAL should have been called once
    expect(mockExecute).toHaveBeenCalledTimes(1)
    expect(mockExecute).toHaveBeenCalledWith(expect.anything())

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

  it('processes multiple tenants independently, inserting deletion_log only once', async () => {
    const TENANT_B = '22222222-2222-2222-2222-222222222222'
    mockAdminWhere.mockResolvedValueOnce([
      { tenantId: TEST_TENANT_ID },
      { tenantId: TENANT_B },
    ])

    const result = await deleteUserData(TEST_PSID, HASH_SALT)

    // One transaction per tenant
    expect(mockDbTransaction).toHaveBeenCalledTimes(2)
    // Both tenants have their conversations deleted
    expect(mockDeleteWhere).toHaveBeenCalledTimes(2)
    // deletion_log INSERT is only done once (index === 0) to avoid UNIQUE violation
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
