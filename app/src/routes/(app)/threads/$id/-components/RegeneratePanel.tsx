'use client'

import { useState } from 'react'
import { SparkleIcon } from '~/components/ui/icons'
import { m } from '~/paraglide/messages'

const INSTRUCTION_MAX = 1000

type Props = {
  // True only when the active draft is in `ready` state (FR-009).
  isVisible: boolean
  // True while a regenerate is in flight (FR-008 — suppress double-fire).
  isRegenerating: boolean
  instruction: string
  onInstructionChange: (value: string) => void
  onRegenerateClick: () => void
}

export function RegeneratePanel({
  isVisible,
  isRegenerating,
  instruction,
  onInstructionChange,
  onRegenerateClick,
}: Props) {
  const [expanded, setExpanded] = useState(false)

  if (!isVisible) return null

  const remaining = INSTRUCTION_MAX - instruction.length
  const overLimit = remaining < 0
  const submitDisabled = isRegenerating || overLimit

  return (
    <div
      style={{
        margin: '6px 0 0',
        borderTop: '1px dashed var(--color-line)',
        paddingTop: 8,
      }}
    >
      {!expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          disabled={isRegenerating}
          aria-label={m.reply_draft_regenerate_button()}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '5px 10px',
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--color-primary-ink)',
            background: 'transparent',
            border: '1px solid var(--color-line)',
            cursor: isRegenerating ? 'not-allowed' : 'pointer',
            opacity: isRegenerating ? 0.5 : 1,
            transition: 'all 120ms',
          }}
        >
          <SparkleIcon size={11} />
          {m.reply_draft_regenerate_button()}
        </button>
      )}

      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <textarea
            value={instruction}
            onChange={(e) => {
              const next = e.target.value
              // Hard cap at INSTRUCTION_MAX (input-level enforcement, FR-010).
              onInstructionChange(next.length > INSTRUCTION_MAX ? next.slice(0, INSTRUCTION_MAX) : next)
            }}
            placeholder={m.reply_draft_regenerate_instruction_placeholder()}
            aria-label={m.reply_draft_regenerate_instruction_placeholder()}
            maxLength={INSTRUCTION_MAX}
            rows={2}
            disabled={isRegenerating}
            style={{
              width: '100%',
              padding: '6px 8px',
              border: '1px solid var(--color-line)',
              borderRadius: 6,
              fontSize: 12.5,
              lineHeight: 1.5,
              resize: 'vertical',
              minHeight: 40,
              color: 'var(--color-ink)',
              background: 'var(--color-bg-raised)',
              opacity: isRegenerating ? 0.6 : 1,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
            <span
              aria-live="polite"
              style={{
                color: overLimit ? 'var(--color-rose-ink)' : 'var(--color-ink-4)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {m.reply_draft_regenerate_chars_remaining({ count: String(remaining) })}
            </span>
            <button
              type="button"
              onClick={() => {
                setExpanded(false)
              }}
              style={{
                marginLeft: 'auto',
                padding: '4px 8px',
                borderRadius: 5,
                fontSize: 11.5,
                color: 'var(--color-ink-3)',
                background: 'transparent',
                border: '1px solid transparent',
                cursor: 'pointer',
              }}
            >
              {/* fold back */}
              ×
            </button>
            <button
              type="button"
              onClick={onRegenerateClick}
              disabled={submitDisabled}
              aria-disabled={submitDisabled}
              style={{
                padding: '5px 10px',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                color: 'white',
                background: submitDisabled ? 'var(--color-ink-4)' : 'var(--color-primary)',
                border: 'none',
                cursor: submitDisabled ? 'not-allowed' : 'pointer',
              }}
            >
              {m.reply_draft_regenerate_submit()}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
