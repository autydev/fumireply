import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const s3Client = new S3Client({ region: process.env.AWS_REGION ?? 'ap-northeast-1' })

export const MAX_ATTACHMENT_BYTES = 26_214_400 // 25 MiB (spec Q4: Messenger 送信上限相当)
export const DOWNLOAD_TIMEOUT_MS = 8_000

export type DownloadResult =
  | { ok: true; buffer: Buffer; contentType: string; sizeBytes: number }
  | { ok: false; reason: 'oversize' | 'http_error' | 'network_error' | 'timeout' }

// Meta の mid は base64 系文字列で `+` `/` `=` を含みうる。正規表現での置換は
// 異なる mid が同一文字列に潰れて S3 キーが衝突しうる (例: 'a+b' と 'a/b') ため、
// 単射な base64url 再エンコードで S3 セーフに変換する。
export function encodeMidForKey(mid: string): string {
  return Buffer.from(mid, 'utf8').toString('base64url')
}

export function buildMediaKey(params: {
  tenantId: string
  conversationId: string
  mid: string
  index: number
}): string {
  return `${params.tenantId}/${params.conversationId}/${encodeMidForKey(params.mid)}/${params.index}`
}

export async function downloadAttachment(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<DownloadResult> {
  const maxBytes = opts.maxBytes ?? MAX_ATTACHMENT_BYTES
  const timeoutMs = opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS

  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError'
    return { ok: false, reason: isTimeout ? 'timeout' : 'network_error' }
  }

  if (!res.ok) {
    // 失敗レスポンスの body は読み捨てて接続を解放する
    await res.arrayBuffer().catch(() => undefined)
    return { ok: false, reason: 'http_error' }
  }

  const contentLength = Number(res.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await res.body?.cancel().catch(() => undefined)
    return { ok: false, reason: 'oversize' }
  }

  // Content-Length が欠落/偽装されていてもメモリを maxBytes + α に抑えるため、
  // ストリーミングで累積しつつ超過時点で中断する。
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    if (!res.body) {
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.byteLength > maxBytes) return { ok: false, reason: 'oversize' }
      chunks.push(buf)
      total = buf.byteLength
    } else {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined)
          return { ok: false, reason: 'oversize' }
        }
        chunks.push(value)
      }
    }
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError'
    return { ok: false, reason: isTimeout ? 'timeout' : 'network_error' }
  }

  return {
    ok: true,
    buffer: Buffer.concat(chunks),
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    sizeBytes: total,
  }
}

export async function storeAttachment(params: {
  bucket: string
  tenantId: string
  conversationId: string
  mid: string
  index: number
  buffer: Buffer
  contentType: string
}): Promise<string> {
  const key = buildMediaKey(params)
  await s3Client.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: key,
      Body: params.buffer,
      ContentType: params.contentType || 'application/octet-stream',
    }),
  )
  return key
}
