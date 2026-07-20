// 009: 純粋関数 classifyAttachments のユニットテスト。
// 006 の determineMessageType / determineEchoMessageType を置換した共通判定 —
// body に添付 URL を入れず、全添付を index 順に AttachmentPlan として返す。
import { describe, expect, it, vi } from 'vitest'

vi.mock('./env', () => ({
  env: {
    SSM_PATH_PREFIX: '/test',
    SQS_QUEUE_URL: 'https://sqs.test/queue',
    AWS_REGION: 'ap-northeast-1',
    MEDIA_BUCKET_NAME: 'test-media-bucket',
  },
}))

const { classifyAttachments } = await import('./handler')

describe('classifyAttachments', () => {
  it('returns text body verbatim with no attachments', () => {
    expect(classifyAttachments({ mid: 'm_1', text: 'Hello world' })).toEqual({
      messageType: 'text',
      body: 'Hello world',
      attachments: [],
    })
  })

  it('classifies image with url as storable, body stays empty (no URL in body)', () => {
    expect(
      classifyAttachments({
        mid: 'm_2',
        attachments: [{ type: 'image', payload: { url: 'https://cdn.example.com/img.jpg' } }],
      }),
    ).toEqual({
      messageType: 'image',
      body: '',
      attachments: [
        { index: 0, type: 'image', url: 'https://cdn.example.com/img.jpg', shouldStore: true },
      ],
    })
  })

  it('classifies sticker (sticker_id wins over att.type) as non-storable', () => {
    const result = classifyAttachments({
      mid: 'm_3',
      attachments: [
        {
          type: 'image',
          payload: { sticker_id: 369239263222822, url: 'https://cdn.example.com/s.png' },
        },
      ],
    })
    expect(result.messageType).toBe('sticker')
    expect(result.attachments[0]).toMatchObject({ type: 'sticker', shouldStore: false })
  })

  it.each(['video', 'audio', 'file'] as const)('classifies %s as storable', (type) => {
    const result = classifyAttachments({
      mid: `m_${type}`,
      attachments: [{ type, payload: { url: `https://cdn.example.com/a.${type}` } }],
    })
    expect(result.messageType).toBe(type)
    expect(result.body).toBe('')
    expect(result.attachments[0]).toMatchObject({ index: 0, type, shouldStore: true })
  })

  it('classifies unsupported type (fallback) as unknown, non-storable', () => {
    const result = classifyAttachments({
      mid: 'm_5',
      attachments: [{ type: 'fallback', payload: { url: 'https://example.com/share' } }],
    })
    expect(result.messageType).toBe('unknown')
    expect(result.attachments[0]).toMatchObject({ type: 'unknown', shouldStore: false })
  })

  it('returns unknown for a message with no text and no attachments', () => {
    expect(classifyAttachments({ mid: 'm_6' })).toEqual({
      messageType: 'unknown',
      body: '',
      attachments: [],
    })
  })

  it('keeps all attachments in index order (multi-attachment)', () => {
    const result = classifyAttachments({
      mid: 'm_7',
      attachments: [
        { type: 'image', payload: { url: 'https://cdn.example.com/1.jpg' } },
        { type: 'video', payload: { url: 'https://cdn.example.com/2.mp4' } },
        { type: 'image', payload: { url: 'https://cdn.example.com/3.jpg' } },
      ],
    })
    expect(result.messageType).toBe('image')
    expect(result.attachments.map((a) => a.index)).toEqual([0, 1, 2])
    expect(result.attachments.map((a) => a.type)).toEqual(['image', 'video', 'image'])
  })

  it('keeps messageType=text when text and attachments coexist, attachments preserved', () => {
    const result = classifyAttachments({
      mid: 'm_8',
      text: 'see this',
      attachments: [{ type: 'image', payload: { url: 'https://cdn.example.com/x.jpg' } }],
    })
    expect(result.messageType).toBe('text')
    expect(result.body).toBe('see this')
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]).toMatchObject({ type: 'image', shouldStore: true })
  })

  it('marks attachment without url as non-storable', () => {
    const result = classifyAttachments({
      mid: 'm_9',
      attachments: [{ type: 'image' }],
    })
    expect(result.attachments[0]).toEqual({
      index: 0,
      type: 'image',
      url: null,
      shouldStore: false,
    })
  })
})
