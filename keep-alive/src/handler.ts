import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'
import postgres from 'postgres'

const SSM_PATH_PREFIX = (process.env.SSM_PATH_PREFIX ?? '/fumireply/review/').replace(/\/$/, '')
const DB_URL_SSM_KEY = `${SSM_PATH_PREFIX}/supabase/db-url`
const RETRY_DELAYS_MS = [500, 1500, 4500]

interface SsmCache {
  value: string
  expiresAt: number
}
const ssmCache = new Map<string, SsmCache>()

let ssmClient: SSMClient | null = null

function getSsmClient(): SSMClient {
  if (ssmClient) return ssmClient
  const region = process.env.AWS_REGION
  if (!region) throw new Error('AWS_REGION is required')
  ssmClient = new SSMClient({ region })
  return ssmClient
}

export async function getSsmParameter(name: string, ttl = 300): Promise<string> {
  const now = Date.now()
  const cached = ssmCache.get(name)
  if (cached && cached.expiresAt > now) return cached.value

  const res = await getSsmClient().send(new GetParameterCommand({ Name: name, WithDecryption: true }))
  const value = res.Parameter?.Value
  if (value === undefined) throw new Error(`SSM parameter not found: ${name}`)
  ssmCache.set(name, { value, expiresAt: now + ttl * 1000 })
  return value
}

let snsClient: SNSClient | null = null

function getSnsClient(): SNSClient {
  if (snsClient) return snsClient
  const region = process.env.AWS_REGION
  if (!region) throw new Error('AWS_REGION is required')
  snsClient = new SNSClient({ region })
  return snsClient
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runKeepalive(
  opts: {
    getSsmParam?: typeof getSsmParameter
    publishSns?: (arn: string, message: string) => Promise<void>
    connectAndPing?: (dbUrl: string) => Promise<void>
  } = {},
): Promise<void> {
  const getSsmParam = opts.getSsmParam ?? getSsmParameter
  const publishSns =
    opts.publishSns ??
    (async (arn: string, message: string) => {
      await getSnsClient().send(new PublishCommand({ TopicArn: arn, Message: message }))
    })
  const connectAndPing =
    opts.connectAndPing ??
    (async (dbUrl: string) => {
      const sql = postgres(dbUrl, { max: 1, prepare: false })
      try {
        await sql`SELECT 1`
      } finally {
        await sql.end()
      }
    })

  const dbUrl = await getSsmParam(DB_URL_SSM_KEY)

  let lastError: unknown = null
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      await connectAndPing(dbUrl)
      return
    } catch (err) {
      lastError = err
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt])
      }
    }
  }

  console.error(
    JSON.stringify({
      level: 'CRITICAL',
      event: 'keepalive_critical',
      message: 'Supabase keep-alive failed after 3 retries',
      error: lastError instanceof Error ? lastError.message : String(lastError),
    }),
  )

  const snsTopicArn = process.env.SNS_TOPIC_ARN ?? ''
  if (snsTopicArn) {
    try {
      await publishSns(snsTopicArn, 'Supabase keep-alive 失敗。手動で Supabase ダッシュボードを確認してください')
    } catch (publishError) {
      console.error(
        JSON.stringify({
          level: 'ERROR',
          event: 'keepalive_sns_publish_failed',
          message: 'Failed to publish keep-alive alert to SNS',
          error: publishError instanceof Error ? publishError.message : String(publishError),
        }),
      )
    }
  }

  throw lastError
}

export const handler = async (): Promise<void> => {
  await runKeepalive()
}
