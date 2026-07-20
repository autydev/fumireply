import { useRef, useState } from 'react'
import { AutoSaveBadge } from '../../-components/AutoSaveBadge'
import { useAutoSave } from '../../-components/useAutoSave'
import { updatePagePromptFn } from '../-lib/update-page-prompt.fn'
import { PAGE_PROMPT_MAX } from '~/lib/settings/char-limits'
import { m } from '~/paraglide/messages'

interface PageCustomPromptEditorProps {
  connectedPageId: string
  pageName: string
  customPrompt: string | null
}

export function PageCustomPromptEditor({ connectedPageId, pageName, customPrompt }: PageCustomPromptEditorProps) {
  const [value, setValue] = useState(customPrompt ?? '')
  // Latest value for the debounced save / error-badge retry (#84).
  const latestValueRef = useRef(value)

  const { state: saveState, schedule, flush } = useAutoSave({
    save: () => updatePagePromptFn({ data: { connectedPageId, customPrompt: latestValueRef.current } }),
  })

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value
    setValue(next)
    latestValueRef.current = next
    schedule()
  }

  const remaining = PAGE_PROMPT_MAX - value.length

  return (
    <div
      style={{
        padding: '16px 20px',
        borderRadius: 10,
        border: '1px solid var(--color-line)',
        background: 'var(--color-bg)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{pageName}</span>
        <AutoSaveBadge state={saveState} onRetry={flush} />
      </div>

      <label
        htmlFor={`prompt-${connectedPageId}`}
        style={{ fontSize: 13, color: 'var(--color-ink-2)', fontWeight: 500 }}
      >
        {m.settings_page_prompt_label()}
      </label>

      <textarea
        id={`prompt-${connectedPageId}`}
        value={value}
        onChange={handleChange}
        maxLength={PAGE_PROMPT_MAX}
        placeholder={m.settings_page_prompt_placeholder()}
        rows={4}
        style={{
          width: '100%',
          resize: 'vertical',
          padding: '8px 10px',
          borderRadius: 8,
          border: '1px solid var(--color-line)',
          fontSize: 13,
          fontFamily: 'inherit',
          background: 'var(--color-bg)',
          color: 'var(--color-ink)',
          outline: 'none',
          boxSizing: 'border-box',
          transition: 'border-color 120ms',
        }}
        onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--color-primary)')}
        onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--color-line)')}
      />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--color-ink-3)' }}>{m.settings_page_prompt_help()}</span>
        <span
          style={{
            fontSize: 11,
            color: remaining < 100 ? 'var(--color-red-ink, #d32f2f)' : 'var(--color-ink-4)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {m.settings_chars_remaining({ remaining })}
        </span>
      </div>
    </div>
  )
}
