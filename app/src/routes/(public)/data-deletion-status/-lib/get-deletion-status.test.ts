import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockAdminWhere = vi.fn()
const mockAdminFrom = vi.fn(() => ({ where: mockAdminWhere }))
const mockAdminSelect = vi.fn(() => ({ from: mockAdminFrom }))
const mockDbAdmin = { select: mockAdminSelect }

vi.mock('~/server/db/client', () => ({ dbAdmin: mockDbAdmin }))

const { getDeletionStatusRecord } = await import('./get-deletion-status')

const TEST_CODE = 'abcdef1234567890abcdef1234567890'
const TEST_ROW = {
  confirmationCode: TEST_CODE,
  deletedAt: '2026-05-01T00:00:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAdminWhere.mockResolvedValue([])
})

describe('getDeletionStatusRecord', () => {
  it('returns the record when the confirmation code exists', async () => {
    mockAdminWhere.mockResolvedValueOnce([TEST_ROW])

    const result = await getDeletionStatusRecord(TEST_CODE)

    expect(result).toEqual(TEST_ROW)
    expect(mockAdminSelect).toHaveBeenCalledTimes(1)
  })

  it('returns null when the confirmation code does not exist', async () => {
    mockAdminWhere.mockResolvedValueOnce([])

    const result = await getDeletionStatusRecord(TEST_CODE)

    expect(result).toBeNull()
  })
})
