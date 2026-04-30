import Anthropic from '@anthropic-ai/sdk'
import { getSsmParameter } from './ssm'

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 300
const MAX_RETRIES = 3

const SYSTEM_PROMPT = `You are a helpful customer support assistant for a TCG (trading card game) retailer.
The customer is messaging on Facebook Messenger asking about products.

Generate a single reply draft based on the customer's latest message and recent
conversation history. The draft will be reviewed and edited by a human operator
before sending — never assume the draft will be sent verbatim.

Guidelines:
- Keep the reply polite and concise (max 300 characters).
- If the customer asks a specific question (price, stock, shipping), answer directly
  if the information is in the conversation; otherwise ask one clarifying question.
- Match the customer's language (Japanese / English).
- Do not include placeholders like [PRICE] or [STOCK] — write what you would actually say.
- Output the reply text only, with no preamble like "Draft:" or "Here is the reply:".`

export type MessageHistoryItem = {
  direction: 'inbound' | 'outbound'
  body: string
}

type DraftResult =
  | {
      ok: true
      body: string
      model: string
      inputTokens: number
      outputTokens: number
      latencyMs: number
    }
  | { ok: false; error: string }

let anthropicClient: Anthropic | null = null

async function getAnthropicClient(apiKeySsmKey: string): Promise<Anthropic> {
  if (!anthropicClient) {
    const apiKey = await getSsmParameter(apiKeySsmKey)
    anthropicClient = new Anthropic({ apiKey })
  }
  return anthropicClient
}

function buildUserPrompt(history: MessageHistoryItem[], latestMessageBody: string): string {
  const lines: string[] = ['Recent conversation:']

  for (const msg of history) {
    const role = msg.direction === 'inbound' ? 'customer' : 'operator'
    lines.push(`[${role}]: ${msg.body}`)
  }

  if (!history.some((m) => m.direction === 'inbound' && m.body === latestMessageBody)) {
    lines.push(`[customer]: ${latestMessageBody}`)
  }

  lines.push('')
  lines.push('Generate a reply to the latest customer message.')
  return lines.join('\n')
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function generateDraft(params: {
  history: MessageHistoryItem[]
  latestMessageBody: string
  apiKeySsmKey: string
}): Promise<DraftResult> {
  const { history, latestMessageBody, apiKeySsmKey } = params
  const client = await getAnthropicClient(apiKeySsmKey)
  const userPrompt = buildUserPrompt(history, latestMessageBody)

  const startTime = Date.now()

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(1000 * Math.pow(3, attempt - 1))
    }

    try {
      const response = await client.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: userPrompt }],
      })

      const latencyMs = Date.now() - startTime
      const content = response.content[0]
      if (content.type !== 'text') {
        return { ok: false, error: 'unexpected_response_type' }
      }

      const usage = response.usage as {
        input_tokens: number
        output_tokens: number
        cache_creation_input_tokens?: number
        cache_read_input_tokens?: number
      }

      return {
        ok: true,
        body: content.text,
        model: response.model,
        inputTokens:
          usage.input_tokens +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0),
        outputTokens: usage.output_tokens,
        latencyMs,
      }
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        if (err.status === 401) {
          return { ok: false, error: 'auth_failed' }
        }
        if (err.status === 400) {
          return { ok: false, error: 'bad_request' }
        }
        // 429 or 5xx: retry
        if (attempt < MAX_RETRIES - 1) continue
        return { ok: false, error: err.status >= 500 ? 'server_error' : 'rate_limited' }
      }
      throw err
    }
  }

  return { ok: false, error: 'server_error' }
}

export { buildUserPrompt }
