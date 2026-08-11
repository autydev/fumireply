import { eq } from 'drizzle-orm'
import { conversations } from '~/server/db/schema'
import type { TenantTx } from '~/server/db/with-tenant'
import { env } from '~/server/env'
import { buildOutboundKey, presignUploadUrl } from '~/server/services/media-upload'
import { TWENTY_FOUR_HOURS_MS } from './send-reply.server'

export type CreateUploadUrlResult =
  | { ok: true; s3Key: string; uploadUrl: string }
  | { ok: false; error: 'not_found' | 'outside_window' | 'not_configured' | 'validation_failed' }

// 事前アップロード URL 発行の純ロジック。会話帰属 (withTenant/RLS) と 24h ウィンドウを
// 検証し、サーバー採番キーに対する presigned PUT URL を返す (contracts §2)。
// I/O は presign のローカル署名のみ (ネットワークなし)。
export async function handleCreateUploadUrl(
  tx: TenantTx,
  tenantId: string,
  data: { conversationId: string; contentType: string; sizeBytes: number },
): Promise<CreateUploadUrlResult> {
  const convRows = await tx
    .select({ id: conversations.id, lastInboundAt: conversations.lastInboundAt })
    .from(conversations)
    .where(eq(conversations.id, data.conversationId))
    .limit(1)

  const conv = convRows[0]
  // withTenant (RLS) を通過して見えない = 他テナント or 存在しない
  if (!conv) return { ok: false, error: 'not_found' }

  // アップロード時点でもウィンドウを弾いて無駄なアップロードを防ぐ
  if (!conv.lastInboundAt || Date.now() - new Date(conv.lastInboundAt).getTime() >= TWENTY_FOUR_HOURS_MS) {
    return { ok: false, error: 'outside_window' }
  }

  const bucket = env.MEDIA_BUCKET_NAME
  if (!bucket) return { ok: false, error: 'not_configured' }

  const s3Key = buildOutboundKey(tenantId, data.conversationId)
  const uploadUrl = await presignUploadUrl({
    bucket,
    key: s3Key,
    contentType: data.contentType,
    sizeBytes: data.sizeBytes,
  })

  console.info({
    event: 'outbound_upload_url_issued',
    tenantId,
    conversationId: data.conversationId,
    s3Key,
    contentType: data.contentType,
    sizeBytes: data.sizeBytes,
  })

  return { ok: true, s3Key, uploadUrl }
}
