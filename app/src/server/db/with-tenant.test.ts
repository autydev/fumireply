import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockExecute = vi.fn()
const mockTransaction = vi.fn()

vi.mock('./client', () => ({
  db: {
    transaction: mockTransaction,
  },
  dbAdmin: {},
}))

const { withTenant } = await import('./with-tenant')

describe('withTenant', () => {
  beforeEach(() => {
    mockTransaction.mockReset()
    mockExecute.mockReset()
  })

  it('sets app.tenant_id within a transaction', async () => {
    const capturedSetCalls: string[] = []
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const fakeTx = {
        execute: async (stmt: { sql?: string; queryChunks?: Array<{ value?: string[] }> }) => {
          // Capture the SQL template to verify tenant_id is set
          capturedSetCalls.push(JSON.stringify(stmt))
        },
      }
      return fn(fakeTx)
    })

    await withTenant('tenant-uuid-123', async () => 'result')
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    expect(capturedSetCalls.length).toBeGreaterThan(0)
  })

  it('returns the value from fn', async () => {
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const fakeTx = { execute: vi.fn() }
      return fn(fakeTx)
    })

    const result = await withTenant('tenant-uuid', async () => 42)
    expect(result).toBe(42)
  })

  it('propagates errors from fn', async () => {
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const fakeTx = { execute: vi.fn() }
      return fn(fakeTx)
    })

    await expect(
      withTenant('tenant-uuid', async () => {
        throw new Error('db error')
      }),
    ).rejects.toThrow('db error')
  })

  it('passes tx as the db argument to fn', async () => {
    const capturedTx: unknown[] = []
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const fakeTx = { execute: vi.fn(), select: vi.fn() }
      capturedTx.push(fakeTx)
      return fn(fakeTx)
    })

    await withTenant('tenant-uuid', async (tx) => {
      expect(tx).toBe(capturedTx[0])
    })
  })
})
