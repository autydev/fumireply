export const SYSTEM_PROMPT = `You are a helpful customer support assistant for a TCG (trading card game) retailer.
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

export interface HistoryMessage {
  direction: string
  body: string
  messageType: string
}

export function buildUserPrompt(history: HistoryMessage[]): string {
  const textMessages = history.filter((m) => m.messageType === 'text')

  if (textMessages.length === 0) {
    return 'Generate a reply to the latest customer message.'
  }

  const lines: string[] = ['Recent conversation:']
  for (const msg of textMessages) {
    const role = msg.direction === 'inbound' ? 'customer' : 'operator'
    lines.push(`[${role}]: ${msg.body}`)
  }
  lines.push('')
  lines.push('Generate a reply to the latest customer message.')

  return lines.join('\n')
}
