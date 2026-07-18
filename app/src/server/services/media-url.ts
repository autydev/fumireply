import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '~/server/env'

let client: S3Client | null = null

function getClient(): S3Client {
  if (client) return client
  client = new S3Client({ region: env.AWS_REGION })
  return client
}

export const ATTACHMENT_URL_EXPIRES_IN = 3600 // 1h — スレッド画面のポーリング再取得で自然に更新される

// 009: 保存済み添付の presigned GET URL を発行する。署名はローカル計算のみで
// ネットワーク I/O なし。呼び出し側は withTenant (RLS) を通過した行の s3Key だけを
// 渡すこと — それがテナント分離 (FR-010/FR-011) の境界になる。
export async function getAttachmentUrl(s3Key: string): Promise<string | null> {
  if (!env.MEDIA_BUCKET_NAME) return null
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: env.MEDIA_BUCKET_NAME, Key: s3Key }),
    { expiresIn: ATTACHMENT_URL_EXPIRES_IN },
  )
}
