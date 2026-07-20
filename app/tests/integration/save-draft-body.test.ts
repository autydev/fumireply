// @vitest-environment node
// Integration (#83): handleSaveDraftBody — persists operator edits to the active
// ready draft. Tests: happy path, no-active-draft no-op, input schema shape.

import { describe, expect, it } from 'vitest'
import type { TenantTx } from '~/server/db/with-tenant'
import {
  handleSaveDraftBody,
  saveDraftBodySchema,
} from '~/routes/(app)/threads/$id/-lib/save-draft-body.server'

const CONV_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function buildUpdateTx(
  affected: Array<{ id: string }>,
  capture?: (set: Record<string, unknown>) => void,
) {
  return {
    update: () => ({
      set: (v: Record<string, unknown>) => {
        capture?.(v)
        return { where: () => ({ returning: () => Promise.resolve(affected) }) }
      },
    }),
  } as unknown as TenantTx
}

describe('handleSaveDraftBody', () => {
  it('happy path: updates body + updatedAt and returns saved=true', async () => {
    let capturedSet: Record<string, unknown> | undefined
    const tx = buildUpdateTx([{ id: 'draft-1' }], (v) => {
      capturedSet = v
    })

    const result = await handleSaveDraftBody(tx, {
      conversationId: CONV_ID,
      body: 'Edited reply text',
    })

    expect(result).toEqual({ ok: true, saved: true })
    expect(capturedSet?.body).toBe('Edited reply text')
    expect(capturedSet?.updatedAt).toBeInstanceOf(Date)
  })

  it('no active ready draft (dismissed / pending / none): no-op with saved=false', async () => {
    const tx = buildUpdateTx([])

    const result = await handleSaveDraftBody(tx, {
      conversationId: CONV_ID,
      body: 'Edited after dismiss',
    })

    expect(result).toEqual({ ok: true, saved: false })
  })

  it('schema: accepts empty body (clearing the draft text is a valid edit)', () => {
    const parsed = saveDraftBodySchema.safeParse({ conversationId: CONV_ID, body: '' })
    expect(parsed.success).toBe(true)
  })

  it('schema: rejects non-uuid conversationId', () => {
    const parsed = saveDraftBodySchema.safeParse({ conversationId: 'nope', body: 'x' })
    expect(parsed.success).toBe(false)
  })
})
