import { z } from 'zod'

const schema = z.object({
  SSM_PATH_PREFIX: z.string().min(1),
  SQS_QUEUE_URL: z.string().min(1),
  AWS_REGION: z.string().min(1).default('ap-northeast-1'),
  MASTER_KEY_SSM_PATH: z.string().min(1).default('/fumireply/master-encryption-key'),
  // Debounce window for draft generation. Consecutive inbound messages within
  // this window coalesce into a single conversation-scoped draft (SQS DelaySeconds).
  DRAFT_DEBOUNCE_SECONDS: z.coerce.number().int().min(0).max(900).default(20),
  // 009: 添付メディア保存先バケット。未設定時は添付保存をスキップし
  // 種別記録のみ行う (research.md R11 のフェイルセーフ)。
  MEDIA_BUCKET_NAME: z.string().default(''),
})

export const env = schema.parse(process.env)
