import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'
import { env } from '~/server/env'
import { UPLOAD_URL_EXPIRES_IN } from '~/lib/media-constants'

// 010: 純粋な定数・型はクライアントからも参照できる ~/lib/media-constants に集約し、
// ここでは S3/env に依存するユーティリティのみを持つ。定数は re-export して
// サーバー側の import 元 (send-reply / messenger 等) を変えずに済ませる。
export {
  ALLOWED_IMAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  UPLOAD_URL_EXPIRES_IN,
  SEND_TOTAL_BUDGET_MS,
  SEND_MIN_ATTEMPT_MS,
  isAllowedImageType,
  type AllowedImageType,
} from '~/lib/media-constants'

let client: S3Client | null = null

// media-url.ts と同じ lazy singleton / region 方針。
function getClient(): S3Client {
  if (client) return client
  client = new S3Client({ region: env.AWS_REGION })
  return client
}

// サーバー採番のみ。クライアント指定キーは受けない (contracts §2 禁止事項)。
// 受信側 009 の `{tenantId}/{conversationId}/{mid}/{index}` と対を成す送信側キー。
export function buildOutboundKey(tenantId: string, conversationId: string): string {
  return `${tenantId}/${conversationId}/outbound/${randomUUID()}/0`
}

// tenantId は auth 由来、conversationId は入力値。正規表現で持ち込みキーを弾く (FR-010)。
export function isValidOutboundKey(
  key: string,
  tenantId: string,
  conversationId: string,
): boolean {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${escape(tenantId)}/${escape(conversationId)}/outbound/[0-9a-f-]{36}/0$`)
  return re.test(key)
}

// presigned PUT URL を発行。ContentType と ContentLength を PutObjectCommand に含めて署名する
// (research D1) ことで、S3 がアップロード時点で型とサイズを強制する。
export async function presignUploadUrl(params: {
  bucket: string
  key: string
  contentType: string
  sizeBytes: number
}): Promise<string> {
  const { bucket, key, contentType, sizeBytes } = params
  return getSignedUrl(
    getClient(),
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: sizeBytes,
    }),
    { expiresIn: UPLOAD_URL_EXPIRES_IN },
  )
}

// 送信時点でアップロード済みオブジェクトが規約に合致するかの最終確認 (HeadObject)。
// 存在しなければ null。IAM は既存 s3:GetObject でカバー (contracts §9)。
export async function verifyUploadedObject(params: {
  bucket: string
  key: string
}): Promise<{ contentType: string | undefined; contentLength: number | undefined } | null> {
  const { bucket, key } = params
  try {
    const head = await getClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return { contentType: head.ContentType, contentLength: head.ContentLength }
  } catch {
    // NoSuchKey / NotFound / アクセス不可 いずれも「検証不能」として null。
    return null
  }
}
