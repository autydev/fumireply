import { useRef, useState } from 'react'
import { AutoSaveBadge } from '../../-components/AutoSaveBadge'
import { useAutoSave } from '../../-components/useAutoSave'
import { updatePagePromptFn } from '../-lib/update-page-prompt.fn'
import { updatePagePriceGuideFn } from '../-lib/update-page-price-guide.fn'
import { PAGE_PROMPT_MAX, PRICE_GUIDE_MAX } from '~/lib/settings/char-limits'
import { m } from '~/paraglide/messages'

interface PageCustomPromptEditorProps {
  connectedPageId: string
  pageName: string
  customPrompt: string | null
  priceGuide: string | null
}

// A single debounced auto-saving textarea field. Each field owns its own save
// lifecycle so the shop-policy and price-guide fields save independently.
function AutoSaveField({
  id,
  label,
  help,
  placeholder,
  maxLength,
  initialValue,
  onSave,
}: {
  id: string
  label: string
  help: string
  placeholder: string
  maxLength: number
  initialValue: string | null
  onSave: (value: string) => Promise<unknown>
}) {
  const [value, setValue] = useState(initialValue ?? '')
  // Latest value for the debounced save / error-badge retry (#84), kept in sync
  // inside the change handler so retries always send the current text.
  const latestValueRef = useRef(value)

  const { state: saveState, schedule, flush } = useAutoSave({
    save: () => onSave(latestValueRef.current),
  })

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value
    setValue(next)
    latestValueRef.current = next
    schedule()
  }

  const remaining = maxLength - value.length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <label htmlFor={id} style={{ fontSize: 13, color: 'var(--color-ink-2)', fontWeight: 500 }}>
          {label}
        </label>
        <AutoSaveBadge state={saveState} onRetry={flush} />
      </div>

      <textarea
        id={id}
        value={value}
        onChange={handleChange}
        maxLength={maxLength}
        placeholder={placeholder}
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
        <span style={{ fontSize: 12, color: 'var(--color-ink-3)' }}>{help}</span>
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

export function PageCustomPromptEditor({
  connectedPageId,
  pageName,
  customPrompt,
  priceGuide,
}: PageCustomPromptEditorProps) {
  return (
    <div
      style={{
        padding: '16px 20px',
        borderRadius: 10,
        border: '1px solid var(--color-line)',
        background: 'var(--color-bg)',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <span style={{ fontWeight: 600, fontSize: 14 }}>{pageName}</span>

      <AutoSaveField
        id={`prompt-${connectedPageId}`}
        label={m.settings_page_prompt_label()}
        help={m.settings_page_prompt_help()}
        placeholder={m.settings_page_prompt_placeholder()}
        maxLength={PAGE_PROMPT_MAX}
        initialValue={customPrompt}
        onSave={(value) => updatePagePromptFn({ data: { connectedPageId, customPrompt: value } })}
      />

      <AutoSaveField
        id={`price-guide-${connectedPageId}`}
        label={m.settings_page_price_guide_label()}
        help={m.settings_page_price_guide_help()}
        placeholder={m.settings_page_price_guide_placeholder()}
        maxLength={PRICE_GUIDE_MAX}
        initialValue={priceGuide}
        onSave={(value) => updatePagePriceGuideFn({ data: { connectedPageId, priceGuide: value } })}
      />
    </div>
  )
}
