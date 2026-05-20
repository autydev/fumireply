import { m } from '~/paraglide/messages'

interface AiPersonaSummaryProps {
  summary: string | null
  lastSummarizedAt: string | null
}

export function AiPersonaSummary({ summary: _summary, lastSummarizedAt: _lastSummarizedAt }: AiPersonaSummaryProps) {
  return (
    <div style={{ padding: '12px 16px' }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--color-ink-3)',
          marginBottom: 8,
        }}
      >
        {m.cp_section_persona()}
      </div>
      <p
        style={{
          fontSize: 12,
          color: 'var(--color-ink-3)',
          lineHeight: 1.5,
          margin: 0,
          fontStyle: 'italic',
        }}
      >
        {m.cp_persona_empty()}
      </p>
    </div>
  )
}
