// 010: メディア添付の純粋な定数・型。クライアント (ReplyForm) とサーバー
// (media-upload / messenger) の両方から参照できるよう、S3/env に依存しない
// このモジュールに集約する。media-upload.ts はこれを re-export する。

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number]

export const MAX_ATTACHMENT_BYTES = 26_214_400 // 25 MiB — 009 と同値
export const UPLOAD_URL_EXPIRES_IN = 300 // presigned PUT の有効秒数
export const SEND_TOTAL_BUDGET_MS = 25_000 // 2 通の Meta 呼び出し合計の上限 (Lambda 30s - オーバーヘッド ~5s)
export const SEND_MIN_ATTEMPT_MS = 1_500 // sendMessengerReply: 残余がこれ未満なら試行を打ち切り timeout を返す

export function isAllowedImageType(contentType: string): contentType is AllowedImageType {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(contentType)
}
