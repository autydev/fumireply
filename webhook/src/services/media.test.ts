import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockClient } from 'aws-sdk-client-mock'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import {
  buildMediaKey,
  downloadAttachment,
  encodeMidForKey,
  storeAttachment,
} from './media'

const s3Mock = mockClient(S3Client)

afterEach(() => {
  s3Mock.reset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('encodeMidForKey / buildMediaKey', () => {
  it('encodes mid as base64url (S3-safe, no +/=)', () => {
    const encoded = encodeMidForKey('m_a+b/c=d:e')
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).toBe('m_a+b/c=d:e')
  })

  it('is injective: distinct mids that a regex-replace would collapse stay distinct', () => {
    expect(encodeMidForKey('m_ab+cd')).not.toBe(encodeMidForKey('m_ab/cd'))
  })

  it('builds tenant-prefixed key with index', () => {
    const key = buildMediaKey({
      tenantId: 'ten-1',
      conversationId: 'conv-1',
      mid: 'm_a=b',
      index: 2,
    })
    expect(key).toBe(`ten-1/conv-1/${encodeMidForKey('m_a=b')}/2`)
  })
})

describe('downloadAttachment', () => {
  it('returns oversize without reading body when Content-Length exceeds maxBytes', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': String(30 * 1024 * 1024) }),
      body: { cancel },
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await downloadAttachment('https://cdn.example/img.jpg')
    expect(result).toEqual({ ok: false, reason: 'oversize' })
    expect(cancel).toHaveBeenCalled()
  })

  it('aborts with oversize when streaming body exceeds maxBytes without Content-Length', async () => {
    const chunk = new Uint8Array(1024)
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk)
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(stream, { status: 200 })),
    )

    const result = await downloadAttachment('https://cdn.example/img.jpg', {
      maxBytes: 4 * 1024,
    })
    expect(result).toEqual({ ok: false, reason: 'oversize' })
  })

  it('returns timeout reason when fetch aborts via AbortSignal.timeout', async () => {
    const timeoutErr = new Error('The operation was aborted due to timeout')
    timeoutErr.name = 'TimeoutError'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutErr))

    const result = await downloadAttachment('https://cdn.example/img.jpg')
    expect(result).toEqual({ ok: false, reason: 'timeout' })
  })

  it('returns network_error for generic fetch failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))

    const result = await downloadAttachment('https://cdn.example/img.jpg')
    expect(result).toEqual({ ok: false, reason: 'network_error' })
  })

  it('returns http_error for non-2xx responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('gone', { status: 404 })),
    )

    const result = await downloadAttachment('https://cdn.example/img.jpg')
    expect(result).toEqual({ ok: false, reason: 'http_error' })
  })

  it('returns buffer, contentType and sizeBytes on success', async () => {
    const bytes = Buffer.from('fake-image-bytes')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(bytes, {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
      ),
    )

    const result = await downloadAttachment('https://cdn.example/img.jpg')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.buffer.equals(bytes)).toBe(true)
    expect(result.contentType).toBe('image/jpeg')
    expect(result.sizeBytes).toBe(bytes.byteLength)
  })

  it('defaults contentType to application/octet-stream when header is missing', async () => {
    const res = new Response(Buffer.from('x'), { status: 200 })
    res.headers.delete('content-type')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res))

    const result = await downloadAttachment('https://cdn.example/blob')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.contentType).toBe('application/octet-stream')
  })
})

describe('storeAttachment', () => {
  it('puts the object with sanitized key and content type, returning the key', async () => {
    s3Mock.on(PutObjectCommand).resolves({})

    const key = await storeAttachment({
      bucket: 'media-bucket',
      tenantId: 'ten-1',
      conversationId: 'conv-1',
      mid: 'm_x=1',
      index: 0,
      buffer: Buffer.from('data'),
      contentType: 'image/png',
    })

    const expectedKey = `ten-1/conv-1/${encodeMidForKey('m_x=1')}/0`
    expect(key).toBe(expectedKey)
    const calls = s3Mock.commandCalls(PutObjectCommand)
    expect(calls).toHaveLength(1)
    const input = calls[0]!.args[0].input
    expect(input.Bucket).toBe('media-bucket')
    expect(input.Key).toBe(expectedKey)
    expect(input.ContentType).toBe('image/png')
  })

  it('falls back to application/octet-stream for empty contentType', async () => {
    s3Mock.on(PutObjectCommand).resolves({})

    await storeAttachment({
      bucket: 'media-bucket',
      tenantId: 'ten-1',
      conversationId: 'conv-1',
      mid: 'm_y',
      index: 1,
      buffer: Buffer.from('data'),
      contentType: '',
    })

    const input = s3Mock.commandCalls(PutObjectCommand)[0]!.args[0].input
    expect(input.ContentType).toBe('application/octet-stream')
  })
})
