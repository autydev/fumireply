// env proxy は初回アクセスで全必須変数を検証するため、他 fn テストと同じ前提を敷く
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test'
process.env.DATABASE_URL_SERVICE_ROLE = 'postgresql://test:test@localhost:5432/test'
process.env.SUPABASE_URL = 'https://test.supabase.co'
process.env.SUPABASE_PUBLISHABLE_KEY = 'test-key'
process.env.SUPABASE_SECRET_KEY = 'test-secret'
process.env.META_APP_ID = 'test-app-id'
process.env.META_APP_SECRET_SSM_KEY = '/test/meta/secret'
process.env.WEBHOOK_VERIFY_TOKEN_SSM_KEY = '/test/webhook/token'
process.env.ANTHROPIC_API_KEY_SSM_KEY = '/test/anthropic/key'
process.env.AWS_REGION = 'ap-northeast-1'
process.env.MEDIA_BUCKET_NAME = 'test-media-bucket'

import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ALLOWED_IMAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  UPLOAD_URL_EXPIRES_IN,
  buildOutboundKey,
  isValidOutboundKey,
  presignUploadUrl,
  verifyUploadedObject,
} from './media-upload'

const s3Mock = mockClient(S3Client)

const TENANT = '00000000-0000-0000-0000-0000000000a1'
const CONV = '00000000-0000-0000-0000-0000000000b2'

beforeEach(() => s3Mock.reset())
afterEach(() => s3Mock.reset())

describe('constants', () => {
  it('MAX_ATTACHMENT_BYTES = 25 MiB (009 と同値)', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(26_214_400)
  })
  it('ALLOWED_IMAGE_TYPES covers jpeg/png/gif/webp', () => {
    expect(ALLOWED_IMAGE_TYPES).toEqual(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
  })
})

describe('buildOutboundKey', () => {
  it('returns {tenant}/{conv}/outbound/{uuid}/0 形式', () => {
    const key = buildOutboundKey(TENANT, CONV)
    expect(key).toMatch(
      new RegExp(`^${TENANT}/${CONV}/outbound/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/0$`),
    )
  })
  it('生成キーは自前の isValidOutboundKey を通る', () => {
    const key = buildOutboundKey(TENANT, CONV)
    expect(isValidOutboundKey(key, TENANT, CONV)).toBe(true)
  })
  it('毎回 UUID が異なる', () => {
    expect(buildOutboundKey(TENANT, CONV)).not.toBe(buildOutboundKey(TENANT, CONV))
  })
})

describe('isValidOutboundKey', () => {
  const uuid = '11111111-2222-3333-4444-555555555555'
  const valid = `${TENANT}/${CONV}/outbound/${uuid}/0`

  it('自会話キーを通す', () => {
    expect(isValidOutboundKey(valid, TENANT, CONV)).toBe(true)
  })
  it('他テナントのキーを弾く', () => {
    const other = '00000000-0000-0000-0000-0000000000ff'
    expect(isValidOutboundKey(valid, other, CONV)).toBe(false)
  })
  it('他会話のキーを弾く', () => {
    const other = '00000000-0000-0000-0000-0000000000ee'
    expect(isValidOutboundKey(valid, TENANT, other)).toBe(false)
  })
  it('outbound 以外のプレフィックスを弾く', () => {
    expect(isValidOutboundKey(`${TENANT}/${CONV}/inbound/${uuid}/0`, TENANT, CONV)).toBe(false)
  })
  it('UUID 不正を弾く', () => {
    expect(isValidOutboundKey(`${TENANT}/${CONV}/outbound/not-a-uuid/0`, TENANT, CONV)).toBe(false)
  })
  it('index≠0 を弾く', () => {
    expect(isValidOutboundKey(`${TENANT}/${CONV}/outbound/${uuid}/1`, TENANT, CONV)).toBe(false)
  })
  it('末尾に余分なパスがあると弾く', () => {
    expect(isValidOutboundKey(`${TENANT}/${CONV}/outbound/${uuid}/0/x`, TENANT, CONV)).toBe(false)
  })
})

describe('presignUploadUrl', () => {
  it('署名済み URL にキーと有効期限クエリを含む', async () => {
    const key = buildOutboundKey(TENANT, CONV)
    const url = await presignUploadUrl({
      bucket: 'test-media-bucket',
      key,
      contentType: 'image/jpeg',
      sizeBytes: 1234,
    })
    // キーはパスとして URL に載る (スラッシュは非エンコード)
    expect(url).toContain(`/${key}?`)
    expect(url).toContain(`X-Amz-Expires=${UPLOAD_URL_EXPIRES_IN}`)
    // ContentLength は署名対象ヘッダとして SignedHeaders (content-length) に含まれる
    expect(url).toContain('content-length')
  })
})

describe('verifyUploadedObject', () => {
  it('Head の contentType/contentLength を返す', async () => {
    s3Mock.on(HeadObjectCommand).resolves({ ContentType: 'image/png', ContentLength: 4096 })
    const res = await verifyUploadedObject({ bucket: 'test-media-bucket', key: 'k' })
    expect(res).toEqual({ contentType: 'image/png', contentLength: 4096 })
  })
  it('存在しなければ null', async () => {
    s3Mock.on(HeadObjectCommand).rejects(
      Object.assign(new Error('Not Found'), { name: 'NotFound' }),
    )
    const res = await verifyUploadedObject({ bucket: 'test-media-bucket', key: 'missing' })
    expect(res).toBeNull()
  })
})
