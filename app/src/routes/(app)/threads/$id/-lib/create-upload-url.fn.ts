import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authMiddleware } from '~/server/middleware/auth-middleware'
import { withTenant } from '~/server/db/with-tenant'
import { ALLOWED_IMAGE_TYPES, MAX_ATTACHMENT_BYTES } from '~/server/services/media-upload'
import { handleCreateUploadUrl } from './create-upload-url.server'

export type { CreateUploadUrlResult } from './create-upload-url.server'

const inputSchema = z.object({
  conversationId: z.string().uuid(),
  contentType: z.enum(ALLOWED_IMAGE_TYPES),
  sizeBytes: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
})

// 010: オペレーターが画像を送る前に、ブラウザが S3 へ直接 PUT するための
// 事前アップロード URL を発行する。キーはサーバー採番のみ (クライアント指定不可)。
export const createUploadUrlFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(inputSchema)
  .handler(async ({ data, context }) => {
    const tenantId = context.user.tenantId
    return withTenant(tenantId, (tx) => handleCreateUploadUrl(tx, tenantId, data))
  })
