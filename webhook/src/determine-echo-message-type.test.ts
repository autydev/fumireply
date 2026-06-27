// 006: 純粋関数 determineEchoMessageType のユニットテスト。
// inbound 用 determineMessageType との差分: echo の image 添付は URL を body に入れず空文字にする。
import { describe, expect, it, vi } from 'vitest'

vi.mock('./env', () => ({
  env: {
    SSM_PATH_PREFIX: '/test',
    SQS_QUEUE_URL: 'https://sqs.test/queue',
    AWS_REGION: 'ap-northeast-1',
  },
}))

const { determineEchoMessageType } = await import('./handler')

describe('determineEchoMessageType', () => {
  it('returns text body verbatim for text message', () => {
    expect(determineEchoMessageType({ mid: 'm_1', text: 'Hello world' })).toEqual({
      messageType: 'text',
      body: 'Hello world',
    })
  })

  it('returns empty body for sticker', () => {
    expect(
      determineEchoMessageType({
        mid: 'm_2',
        attachments: [{ type: 'image', payload: { sticker_id: 369239263222822 } }],
      }),
    ).toEqual({ messageType: 'sticker', body: '' })
  })

  it('returns empty body for image (echo path does NOT save URL)', () => {
    expect(
      determineEchoMessageType({
        mid: 'm_3',
        attachments: [{ type: 'image', payload: { url: 'https://cdn.example.com/img.jpg' } }],
      }),
    ).toEqual({ messageType: 'image', body: '' })
  })

  it('returns unknown for empty / unsupported payload', () => {
    expect(determineEchoMessageType({ mid: 'm_4' })).toEqual({
      messageType: 'unknown',
      body: '',
    })
  })
})
