import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '~/server/env'

let client: S3Client | null = null

function getClient(): S3Client {
  if (client) return client
  client = new S3Client({ region: env.AWS_REGION })
  return client
}

export const ATTACHMENT_URL_EXPIRES_IN = 3600 // 1h

// 署名時刻の量子化幅。スレッド画面は 7 秒ポーリングで getConversation を再実行するため、
// 呼び出しごとに署名し直すと URL (X-Amz-Date/署名) が毎回変わり、ブラウザキャッシュが
// 効かず <img> が 7 秒ごとに S3 から再取得される。署名時刻を 15 分単位に丸めることで
// 同一ウィンドウ内は同一 URL になり、有効期限は最短でも 45 分残る。
const SIGNING_WINDOW_MS = 15 * 60 * 1000

interface CacheEntry {
  url: string
  windowStart: number
}

const urlCache = new Map<string, CacheEntry>()

// 009: 保存済み添付の presigned GET URL を発行する。署名はローカル計算のみで
// ネットワーク I/O なし。呼び出し側は withTenant (RLS) を通過した行の s3Key だけを
// 渡すこと — それがテナント分離 (FR-010/FR-011) の境界になる。
export async function getAttachmentUrl(s3Key: string): Promise<string | null> {
  if (!env.MEDIA_BUCKET_NAME) return null

  const windowStart = Math.floor(Date.now() / SIGNING_WINDOW_MS) * SIGNING_WINDOW_MS
  const cached = urlCache.get(s3Key)
  if (cached && cached.windowStart === windowStart) return cached.url

  const url = await getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: env.MEDIA_BUCKET_NAME, Key: s3Key }),
    { expiresIn: ATTACHMENT_URL_EXPIRES_IN, signingDate: new Date(windowStart) },
  )
  // 無制限に伸びないよう、閾値超過時に旧ウィンドウのエントリを掃除する
  if (urlCache.size >= 5000) {
    for (const [key, entry] of urlCache) {
      if (entry.windowStart !== windowStart) urlCache.delete(key)
    }
  }
  urlCache.set(s3Key, { url, windowStart })
  return url
}
