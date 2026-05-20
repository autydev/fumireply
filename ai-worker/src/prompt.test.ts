import { describe, expect, it } from 'vitest'
import { buildAdditionalSystemPrompt, buildSummaryPrompt, TONE_LABEL } from './prompt'

describe('buildAdditionalSystemPrompt', () => {
  it('returns empty string when all args are null', () => {
    expect(
      buildAdditionalSystemPrompt({
        pagePrompt: null,
        tonePreset: null,
        customerPrompt: null,
        summary: null,
      }),
    ).toBe('')
  })

  it('includes shop policy section when pagePrompt is set', () => {
    const result = buildAdditionalSystemPrompt({
      pagePrompt: 'No returns after 30 days.',
      tonePreset: null,
      customerPrompt: null,
      summary: null,
    })
    expect(result).toContain('## Shop policy:')
    expect(result).toContain('No returns after 30 days.')
  })

  it('includes tone section with TONE_LABEL when tonePreset is set', () => {
    for (const preset of ['friendly', 'professional', 'concise'] as const) {
      const result = buildAdditionalSystemPrompt({
        pagePrompt: null,
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
      tonePreset: null,
      customerPrompt: null,
      summary: 'Customer asked about Charizard prices.',
    })
    expect(result).toContain('## Conversation summary:')
    expect(result).toContain('Customer asked about Charizard prices.')
  })

  it('composes sections in Page → Tone → Customer → Summary order when all present', () => {
    const result = buildAdditionalSystemPrompt({
      pagePrompt: 'Policy text',
      tonePreset: 'concise',
      customerPrompt: 'Custom instruction',
      summary: 'Summary text',
    })
    const policyIdx = result.indexOf('## Shop policy:')
    const toneIdx = result.indexOf('## Customer-specific tone:')
    const customerIdx = result.indexOf('## Customer-specific instructions:')
    const summaryIdx = result.indexOf('## Conversation summary:')
    expect(policyIdx).toBeLessThan(toneIdx)
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
