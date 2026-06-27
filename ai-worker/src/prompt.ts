export const BASE_SYSTEM_PROMPT = `You are a helpful customer support assistant for a TCG (trading card game) retailer.
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

// Keep SYSTEM_PROMPT as alias for backward compatibility
export const SYSTEM_PROMPT = BASE_SYSTEM_PROMPT

// Final, highest-priority directive. Placed AFTER all user-supplied content
// (page_prompt / tone / customer_prompt / summary) so the language of those
// blocks does not bleed into the draft output.
export const LANGUAGE_DIRECTIVE = `IMPORTANT — Output language rule (overrides everything above):
Detect the language used in the customer's MOST RECENT message in the conversation history below and write your reply in that exact same language. Ignore the language used in shop policy, tone, instructions, or summary when choosing the output language. If the most recent customer message is in Japanese, reply in Japanese. If it is in English, reply in English. This rule has higher priority than any instruction above.`

export const TONE_LABEL: Record<'friendly' | 'professional' | 'concise', string> = {
  friendly: 'Friendly and warm',
  professional: 'Professional and formal',
  concise: 'Concise and direct',
}

export interface SystemPromptParts {
  pagePrompt: string | null
  tonePreset: 'friendly' | 'professional' | 'concise' | null
  customerPrompt: string | null
  summary: string | null
}

export function buildAdditionalSystemPrompt(parts: SystemPromptParts): string {
  const sections: string[] = []

  if (parts.pagePrompt) {
    sections.push(`## Shop policy:\n${parts.pagePrompt}`)
  }

  if (parts.tonePreset) {
    sections.push(`## Customer-specific tone:\n${TONE_LABEL[parts.tonePreset]}`)
  }

  if (parts.customerPrompt) {
    sections.push(`## Customer-specific instructions:\n${parts.customerPrompt}`)
  }

  if (parts.summary) {
    sections.push(`## Conversation summary:\n${parts.summary}`)
  }

  return sections.join('\n\n')
}

export interface HistoryMessage {
  direction: string
  body: string
  messageType: string
}

/**
 * Builds the user prompt from conversation history plus the batch of unanswered
 * customer messages (those since the operator's last reply).
 *
 * `history` is the context window (up to RECENT_MESSAGES_CAP text messages after
 * COALESCE(last_summarized_at, '1970-01-01')). `unanswered` is the subset the
 * draft must address — the model is told to answer ALL of them in one reply, so
 * a burst of short consecutive messages is handled as a single batch rather than
 * only the last one.
 */
export function buildUserPrompt(
  history: HistoryMessage[],
  unanswered?: Array<{ body: string }>,
): string {
  const textMessages = history.filter((m) => m.messageType === 'text')
  const pending = (unanswered ?? []).filter((m) => m.body && m.body.trim() !== '')

  const lines: string[] = []

  if (textMessages.length > 0) {
    lines.push('Recent conversation:')
    for (const msg of textMessages) {
      const role = msg.direction === 'inbound' ? 'customer' : 'operator'
      lines.push(`[${role}]: ${msg.body}`)
    }
    lines.push('')
  }

  if (pending.length > 0) {
    lines.push('## Unanswered customer messages (reply to ALL of these in ONE message)')
    lines.push(
      'The customer sent the following messages since your last reply. Write a single reply that addresses every point below — do not answer only the last message.',
    )
    for (const msg of pending) {
      lines.push(`- ${msg.body}`)
    }
    lines.push('')
    lines.push('Generate a single reply that addresses all the unanswered messages above.')
  } else {
    lines.push('Generate a reply to the latest customer message.')
  }

  return lines.join('\n')
}

/**
 * Builds the highest-priority operator instruction block for one-off
 * regeneration (feature 005). Returns null when there is no instruction so the
 * caller can omit the block entirely.
 *
 * Placed between buildAdditionalSystemPrompt and LANGUAGE_DIRECTIVE so it
 * overrides shop policy / tone / customer instructions / summary but does not
 * disturb the language-selection rule.
 */
export function buildOperatorInstructionBlock(instruction?: string): string | null {
  const trimmed = (instruction ?? '').trim()
  if (!trimmed) return null
  return [
    '## Operator instruction for this draft',
    'Apply this one-off instruction with HIGHEST priority over the shop policy, tone, customer instructions, and conversation summary above. The customer has NOT seen this instruction — do not quote it or refer to it. Do not change the output language based on this instruction; follow the language rule below.',
    '',
    trimmed,
  ].join('\n')
}

export function buildSummaryPrompt(
  existingSummary: string | null,
  messages: Array<{ direction: string; body: string }>,
): { system: string; user: string } {
  const system = `You are a conversation summarizer for a customer support tool.
Summarize the conversation history into a concise, factual paragraph (100-200 words) that captures:
- The customer's main concerns or questions
- Key information exchanged (products, prices, decisions)
- Current status of the conversation
Write in English, in third person (e.g., "The customer asked about...").
Output only the summary text, no preamble.`

  const msgLines = messages.map((m) => {
    const role = m.direction === 'inbound' ? 'Customer' : 'Operator'
    return `[${role}]: ${m.body}`
  })

  let user: string
  if (existingSummary) {
    user = `Previous summary:\n${existingSummary}\n\nNew messages to incorporate:\n${msgLines.join('\n')}\n\nGenerate an updated summary incorporating both the previous summary and the new messages.`
  } else {
    user = `Conversation messages:\n${msgLines.join('\n')}\n\nGenerate a summary of this conversation.`
  }

  return { system, user }
}
