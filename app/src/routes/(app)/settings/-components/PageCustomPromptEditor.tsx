import { useState, useEffect, useRef } from 'react'
import { AutoSaveBadge } from '../../-components/AutoSaveBadge'
import type { AutoSaveState } from '../../-components/AutoSaveBadge'
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
  const [saveState, setSaveState] = useState<AutoSaveState>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestValueRef = useRef(value)
  // Monotonically increasing save ID — only the latest save's completion updates state
  const saveIdRef = useRef(0)

  useEffect(() => {
    latestValueRef.current = value
  }, [value])

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value
    setValue(next)
    setSaveState('editing')

    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      const currentSaveId = ++saveIdRef.current
      setSaveState('saving')
      try {
        await updatePagePromptFn({ data: { connectedPageId, customPrompt: latestValueRef.current } })
        if (saveIdRef.current === currentSaveId) setSaveState('saved')
      } catch {
        if (saveIdRef.current === currentSaveId) setSaveState(null)
      }
    }, 500)
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

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
        <AutoSaveBadge state={saveState} />
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
