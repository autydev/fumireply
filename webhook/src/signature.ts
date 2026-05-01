import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifySignature(rawBody: string, signature: string, appSecret: string): boolean {
  if (!signature.startsWith('sha256=')) return false
  const expected = Buffer.from(
    createHmac('sha256', appSecret).update(rawBody, 'utf-8').digest('hex'),
    'hex',
  )
  const provided = Buffer.from(signature.slice('sha256='.length), 'hex')
  if (expected.length !== provided.length) return false
  return timingSafeEqual(expected, provided)
}
