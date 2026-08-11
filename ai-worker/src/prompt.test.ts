import { describe, expect, it } from 'vitest'
import {
  buildAdditionalSystemPrompt,
  buildOperatorInstructionBlock,
  buildSummaryPrompt,
  buildUserPrompt,
  TONE_LABEL,
} from './prompt'

describe('buildAdditionalSystemPrompt', () => {
  it('returns empty string when all args are null', () => {
    expect(
      buildAdditionalSystemPrompt({
        pagePrompt: null,
        priceGuide: null,
        tonePreset: null,
        customerPrompt: null,
        summary: null,
      }),
    ).toBe('')
  })

  it('includes shop policy section when pagePrompt is set', () => {
    const result = buildAdditionalSystemPrompt({
      pagePrompt: 'No returns after 30 days.',
      priceGuide: null,
      tonePreset: null,
      customerPrompt: null,
      summary: null,
    })
    expect(result).toContain('## Shop policy:')
    expect(result).toContain('No returns after 30 days.')
  })

  it('includes price guide section when priceGuide is set', () => {
    const result = buildAdditionalSystemPrompt({
      pagePrompt: null,
      priceGuide: 'Charizard VMAX: ¥3,000–4,000. Pikachu promo: ¥500.',
      tonePreset: null,
      customerPrompt: null,
      summary: null,
    })
    expect(result).toContain('## Product price guide')
    expect(result).toContain('Charizard VMAX: ¥3,000–4,000. Pikachu promo: ¥500.')
  })

  it('includes tone section with TONE_LABEL when tonePreset is set', () => {
    for (const preset of ['friendly', 'professional', 'concise'] as const) {
      const result = buildAdditionalSystemPrompt({
        pagePrompt: null,
        priceGuide: null,
        tonePreset: preset,
        customerPrompt: null,
        summary: null,
      })
      expect(result).toContain('## Customer-specific tone:')
      expect(result).toContain(TONE_LABEL[preset])
    }
  })

  it('includes customer instruction section when customerPrompt is set', () => {
    const result = buildAdditionalSystemPrompt({
      pagePrompt: null,
      priceGuide: null,
      tonePreset: null,
      customerPrompt: 'No emojis.',
      summary: null,
    })
    expect(result).toContain('## Customer-specific instructions:')
    expect(result).toContain('No emojis.')
  })

  it('includes conversation summary section when summary is set', () => {
    const result = buildAdditionalSystemPrompt({
      pagePrompt: null,
      priceGuide: null,
      tonePreset: null,
      customerPrompt: null,
      summary: 'Customer asked about Charizard prices.',
    })
    expect(result).toContain('## Conversation summary:')
    expect(result).toContain('Customer asked about Charizard prices.')
  })

  it('composes sections in Page → Price → Tone → Customer → Summary order when all present', () => {
    const result = buildAdditionalSystemPrompt({
      pagePrompt: 'Policy text',
      priceGuide: 'Price text',
      tonePreset: 'concise',
      customerPrompt: 'Custom instruction',
      summary: 'Summary text',
    })
    const policyIdx = result.indexOf('## Shop policy:')
    const priceIdx = result.indexOf('## Product price guide')
    const toneIdx = result.indexOf('## Customer-specific tone:')
    const customerIdx = result.indexOf('## Customer-specific instructions:')
    const summaryIdx = result.indexOf('## Conversation summary:')
    expect(policyIdx).toBeLessThan(priceIdx)
    expect(priceIdx).toBeLessThan(toneIdx)
    expect(toneIdx).toBeLessThan(customerIdx)
    expect(customerIdx).toBeLessThan(summaryIdx)
  })

  it('does not include note content even if extra properties are present at runtime', () => {
    // TypeScript prevents passing note, but test runtime safety
    const partsWithNote = {
      pagePrompt: null,
      tonePreset: null,
      customerPrompt: null,
      summary: null,
      note: 'Internal note that must not appear',
    } as unknown as Parameters<typeof buildAdditionalSystemPrompt>[0]

    const result = buildAdditionalSystemPrompt(partsWithNote)
    expect(result).not.toContain('Internal note that must not appear')
  })
})

describe('buildOperatorInstructionBlock (005)', () => {
  it('returns null when instruction is undefined', () => {
    expect(buildOperatorInstructionBlock(undefined)).toBeNull()
  })

  it('returns null when instruction is empty', () => {
    expect(buildOperatorInstructionBlock('')).toBeNull()
  })

  it('returns null when instruction is whitespace-only', () => {
    expect(buildOperatorInstructionBlock('   \n\t  ')).toBeNull()
  })

  it('returns a block containing the header and trimmed body', () => {
    const block = buildOperatorInstructionBlock('  do X please  ')
    expect(block).toContain('## Operator instruction for this draft')
    expect(block).toContain('do X please')
    expect(block).not.toMatch(/^  do X please/m)
  })

  it('marks the instruction as HIGHEST priority over additional prompts', () => {
    const block = buildOperatorInstructionBlock('use ¥800')
    expect(block).toContain('HIGHEST priority')
  })

  it('tells the model not to leak the instruction to the customer', () => {
    const block = buildOperatorInstructionBlock('use ¥800')
    expect(block?.toLowerCase()).toContain('customer has not seen')
  })

  it('does not truncate at 1000 chars (validation belongs to the caller)', () => {
    const exactly1000 = 'a'.repeat(1000)
    const block = buildOperatorInstructionBlock(exactly1000)
    expect(block).toContain(exactly1000)
    const over1000 = 'a'.repeat(1500)
    const block2 = buildOperatorInstructionBlock(over1000)
    expect(block2).toContain(over1000)
  })
})

describe('buildUserPrompt (005 follow-up: instruction re-echo)', () => {
  const history = [
    { direction: 'inbound', body: 'How much is the OP-09 set?', messageType: 'text' },
  ]
  const unanswered = [{ body: 'How much is the OP-09 set?' }]

  it('does NOT append an operator block when no instruction is given', () => {
    const result = buildUserPrompt(history, unanswered)
    expect(result).not.toContain('## Operator instruction for this draft (overrides')
  })

  it('does NOT append an operator block for a whitespace-only instruction', () => {
    const result = buildUserPrompt(history, unanswered, '   \n\t ')
    expect(result).not.toContain('## Operator instruction')
  })

  it('appends the operator instruction as the FINAL block of the user turn', () => {
    const result = buildUserPrompt(history, unanswered, 'say we will follow up later')
    expect(result).toContain('## Operator instruction for this draft (overrides the request above)')
    expect(result).toContain('say we will follow up later')
    // Must be the last thing the model reads — after the unanswered directive.
    const opIdx = result.indexOf('## Operator instruction for this draft (overrides')
    const unansweredIdx = result.indexOf('## Unanswered customer messages')
    expect(unansweredIdx).toBeGreaterThanOrEqual(0)
    expect(opIdx).toBeGreaterThan(unansweredIdx)
    expect(result.trimEnd().endsWith('say we will follow up later')).toBe(true)
  })

  it('trims the instruction before echoing', () => {
    const result = buildUserPrompt(history, unanswered, '  do X  ')
    expect(result).toContain('\ndo X')
    expect(result).not.toContain('  do X  ')
  })
})

describe('buildSummaryPrompt', () => {
  const msgs = [
    { direction: 'inbound', body: 'Do you have Charizard?' },
    { direction: 'outbound', body: 'Yes, we have it in stock.' },
  ]

  it('builds prompt without existing summary', () => {
    const { system, user } = buildSummaryPrompt(null, msgs)
    expect(system).toContain('summarizer')
    expect(user).toContain('[Customer]: Do you have Charizard?')
    expect(user).toContain('[Operator]: Yes, we have it in stock.')
    expect(user).not.toContain('Previous summary')
  })

  it('builds prompt with existing summary', () => {
    const { system, user } = buildSummaryPrompt('Customer asked about cards.', msgs)
    expect(system).toContain('summarizer')
    expect(user).toContain('Previous summary:')
    expect(user).toContain('Customer asked about cards.')
    expect(user).toContain('New messages to incorporate:')
  })
})
