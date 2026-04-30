import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'

const client = new SSMClient({ region: process.env.AWS_REGION ?? 'ap-northeast-1' })

interface CacheEntry {
  value: string
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

export async function getSsmParameter(name: string, ttl = 300): Promise<string> {
  const now = Date.now()
  const cached = cache.get(name)
  if (cached && cached.expiresAt > now) {
    return cached.value
  }

  const command = new GetParameterCommand({ Name: name, WithDecryption: true })
  const response = await client.send(command)
  const value = response.Parameter?.Value
  if (value === undefined) {
    throw new Error(`SSM parameter not found: ${name}`)
  }

  cache.set(name, { value, expiresAt: now + ttl * 1000 })
  return value
}

export function clearSsmCache(): void {
  cache.clear()
}
