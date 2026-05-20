import { m } from '~/paraglide/messages'

interface AiPersonaSummaryProps {
  summary: string | null
  lastSummarizedAt: string | null
}

export function AiPersonaSummary({ summary, lastSummarizedAt }: AiPersonaSummaryProps) {
  const formattedAt = lastSummarizedAt
    ? new Date(lastSummarizedAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null

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

      {summary ? (
        <>
          <p
            style={{
              fontSize: 12,
              color: 'var(--color-ink-1)',
              lineHeight: 1.6,
              margin: '0 0 6px 0',
              whiteSpace: 'pre-wrap',
            }}
          >
            {summary}
          </p>
          <p
            style={{
              fontSize: 11,
              color: 'var(--color-ink-3)',
              fontStyle: 'italic',
              margin: '0 0 4px 0',
            }}
          >
            {m.cp_persona_disclaimer()}
          </p>
          {formattedAt && (
            <p style={{ fontSize: 11, color: 'var(--color-ink-3)', margin: 0 }}>
              {m.cp_persona_updated_at({ at: formattedAt })}
            </p>
          )}
        </>
      ) : (
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
      )}
    </div>
  )
}
