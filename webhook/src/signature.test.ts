import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifySignature } from './signature'

const SECRET = 'test-app-secret'
const BODY = '{"object":"page","entry":[]}'

function sign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf-8').digest('hex')
}

describe('verifySignature', () => {
  it('returns true for valid signature', () => {
    expect(verifySignature(BODY, sign(BODY, SECRET), SECRET)).toBe(true)
  })

  it('returns false for wrong secret', () => {
    expect(verifySignature(BODY, sign(BODY, 'wrong-secret'), SECRET)).toBe(false)
  })

  it('returns false when sha256= prefix is missing', () => {
    const raw = createHmac('sha256', SECRET).update(BODY, 'utf-8').digest('hex')
    expect(verifySignature(BODY, raw, SECRET)).toBe(false)
  })

  it('returns false for tampered body', () => {
    const signature = sign(BODY, SECRET)
    expect(verifySignature('{"tampered":true}', signature, SECRET)).toBe(false)
  })

  it('returns false for empty signature', () => {
    expect(verifySignature(BODY, '', SECRET)).toBe(false)
  })
})
