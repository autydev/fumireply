import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_SERVICE_ROLE: z.string().min(1),
  SSM_PATH_PREFIX: z.string().min(1),
  SQS_QUEUE_URL: z.string().min(1),
  AWS_REGION: z.string().min(1).default('ap-northeast-1'),
})

export const env = schema.parse(process.env)
