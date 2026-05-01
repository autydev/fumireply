import { createFileRoute } from '@tanstack/react-router'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { deleteUserData } from './-lib/delete-user-data'

const SSM_PARAMETER_TIMEOUT_MS = 3_000

async function getSsmParameter(name: string): Promise<string> {
  const region = process.env.AWS_REGION?.trim() || 'ap-northeast-1'
  const client = new SSMClient({ region })
  const result = await client.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
    { abortSignal: AbortSignal.timeout(SSM_PARAMETER_TIMEOUT_MS) },
  )
  if (!result.Parameter?.Value) throw new Error(`SSM parameter not found: ${name}`)
  return result.Parameter.Value
}

function base64urlDecode(str: string): Buffer {
  const b64 = str
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(str.length + ((4 - (str.length % 4)) % 4), '=')
  return Buffer.from(b64, 'base64')
}

function verifySignedRequest(
  signedRequest: string,
  appSecret: string,
): { valid: false } | { valid: true; userId: string } {
  const dotIdx = signedRequest.indexOf('.')
  if (dotIdx === -1) return { valid: false }

  const sigPart = signedRequest.slice(0, dotIdx)
  const payloadPart = signedRequest.slice(dotIdx + 1)

  let payload: { algorithm?: string; user_id?: string }
  try {
    payload = JSON.parse(base64urlDecode(payloadPart).toString('utf8')) as typeof payload
  } catch {
    return { valid: false }
  }

  if (payload.algorithm !== 'HMAC-SHA256') return { valid: false }

  const expected = createHmac('sha256', appSecret).update(payloadPart).digest()
  const received = base64urlDecode(sigPart)

  if (expected.length !== received.length) return { valid: false }
  if (!timingSafeEqual(expected, received)) return { valid: false }

  if (!payload.user_id) return { valid: false }

  return { valid: true, userId: payload.user_id }
}

// Exported for unit testing
export async function handleDataDeletion(request: Request): Promise<Response> {
  let signedRequest: string
  try {
    const formData = await request.formData()
    const sr = formData.get('signed_request')
    if (typeof sr !== 'string' || !sr) {
      return new Response('Missing signed_request', { status: 400 })
    }
    signedRequest = sr
  } catch {
    return new Response('Invalid request body', { status: 400 })
  }

  const appSecretKey = process.env.META_APP_SECRET_SSM_KEY?.trim()
  if (!appSecretKey) return new Response('Server misconfiguration', { status: 500 })

  let appSecret: string
  try {
    appSecret = await getSsmParameter(appSecretKey)
  } catch {
    return new Response('Failed to fetch app secret', { status: 500 })
  }

  const verification = verifySignedRequest(signedRequest, appSecret)
  if (!verification.valid) return new Response('Invalid signature', { status: 400 })

  const psid = verification.userId

  const hashSaltKey = process.env.DELETION_LOG_HASH_SALT_SSM_KEY?.trim()
  if (!hashSaltKey) return new Response('Server misconfiguration', { status: 500 })

  let hashSalt: string
  try {
    hashSalt = await getSsmParameter(hashSaltKey)
  } catch {
    return new Response('Failed to fetch hash salt', { status: 500 })
  }

  let confirmationCode: string
  try {
    const result = await deleteUserData(psid, hashSalt)
    confirmationCode = result.confirmationCode
  } catch {
    return new Response('Database error', { status: 500 })
  }

  const origin = process.env.PUBLIC_APP_ORIGIN?.trim()
  if (!origin) return new Response('Server misconfiguration', { status: 500 })

  let appOrigin: URL
  try {
    appOrigin = new URL(origin)
  } catch {
    return new Response('Server misconfiguration', { status: 500 })
  }

  const statusUrl = new URL(`/data-deletion-status/${confirmationCode}`, appOrigin).toString()

  return Response.json({ url: statusUrl, confirmation_code: confirmationCode })
}

export const Route = createFileRoute('/api/data-deletion/')({
  server: {
    handlers: {
      POST: ({ request }) => handleDataDeletion(request),
    },
  },
})
