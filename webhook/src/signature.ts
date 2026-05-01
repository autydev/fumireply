import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifySignature(rawBody: string, signature: string, appSecret: string): boolean {
  if (!signature.startsWith('sha256=')) return false
  const expected = 'sha256=' + createHmac('sha256', appSecret).update(rawBody, 'utf-8').digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
