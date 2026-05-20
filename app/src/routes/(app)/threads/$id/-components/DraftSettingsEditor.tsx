import { useCallback, useEffect, useRef, useState } from 'react'
import { AutoSaveBadge, type AutoSaveState } from '~/routes/(app)/-components/AutoSaveBadge'
import { CUSTOMER_PROMPT_MAX } from '~/lib/settings/char-limits'
import { updateConversationSettingsFn } from '../-lib/update-conversation-settings.fn'
import { m } from '~/paraglide/messages'

type TonePreset = 'friendly' | 'professional' | 'concise' | null

interface DraftSettingsEditorProps {
  conversationId: string
  tonePreset: TonePreset
  customPrompt: string | null
  onUpdate: (fields: { tonePreset?: TonePreset; customPrompt?: string | null }) => void
}

const TONE_OPTIONS: { value: TonePreset; label: () => string }[] = [
  { value: 'friendly', label: m.cp_tone_friendly },
  { value: 'professional', label: m.cp_tone_professional },
  { value: 'concise', label: m.cp_tone_concise },
]

const DEBOUNCE_MS = 500

export function DraftSettingsEditor({
  conversationId,
  tonePreset: initialTone,
  customPrompt: initialPrompt,
  onUpdate,
}: DraftSettingsEditorProps) {
  const [tone, setTone] = useState<TonePreset>(initialTone)
  const [prompt, setPrompt] = useState(initialPrompt ?? '')
  const [promptSaveState, setPromptSaveState] = useState<AutoSaveState>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync if parent reloads
  useEffect(() => { setTone(initialTone) }, [initialTone])
  useEffect(() => { setPrompt(initialPrompt ?? '') }, [initialPrompt])

  // Cancel pending debounce on unmount or conversation change
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [conversationId])

  const saveTone = useCallback(async (value: TonePreset) => {
    try {
      await updateConversationSettingsFn({ data: { conversationId, tonePreset: value } })
      onUpdate({ tonePreset: value })
    } catch {
      // fail silently — user can retry
    }
  }, [conversationId, onUpdate])

  const handleToneClick = useCallback((value: TonePreset) => {
    const next = tone === value ? null : value
    setTone(next)
    void saveTone(next)
  }, [tone, saveTone])

  const handlePromptChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setPrompt(value)
    setPromptSaveState('editing')
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setPromptSaveState('saving')
      try {
        await updateConversationSettingsFn({ data: { conversationId, customPrompt: value } })
        setPromptSaveState('saved')
        onUpdate({ customPrompt: value || null })
      } catch {
        setPromptSaveState(null)
      }
    }, DEBOUNCE_MS)
  }, [conversationId, onUpdate])

  const remaining = CUSTOMER_PROMPT_MAX - prompt.length

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
        {m.cp_section_ai_settings()}
      </div>

      {/* Tone selector */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--color-ink-2)', marginBottom: 6 }}>
          {m.cp_tone_label()}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {TONE_OPTIONS.map(({ value, label }) => {
            const active = tone === value
            return (
              <button
                key={value}
                onClick={() => handleToneClick(value)}
                style={{
                  flex: 1,
                  padding: '5px 0',
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: active ? 600 : 400,
                  cursor: 'pointer',
                  transition: 'background 120ms, color 120ms, border-color 120ms',
                  background: active ? 'var(--color-primary)' : 'var(--color-bg-raised)',
                  color: active ? '#fff' : 'var(--color-ink-2)',
                  border: active
                    ? '1px solid var(--color-primary)'
                    : '1px solid var(--color-line)',
                  boxShadow: active ? '0 1px 2px oklch(0.55 0.16 265 / 0.25)' : 'none',
                }}
              >
                {label()}
              </button>
            )
          })}
        </div>
      </div>

      {/* Custom prompt */}
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 4,
          }}
        >
          <label style={{ fontSize: 12, color: 'var(--color-ink-2)' }}>
            {m.cp_custom_prompt_label()}
          </label>
          <AutoSaveBadge state={promptSaveState} />
        </div>
        <textarea
          value={prompt}
          onChange={handlePromptChange}
          maxLength={CUSTOMER_PROMPT_MAX}
          placeholder={m.cp_custom_prompt_placeholder()}
          rows={3}
          style={{
            width: '100%',
            resize: 'vertical',
            fontSize: 12,
            lineHeight: 1.5,
            padding: '6px 8px',
            borderRadius: 6,
            border: '1px solid var(--color-line)',
            background: 'var(--color-bg-raised)',
            color: 'var(--color-ink)',
            boxSizing: 'border-box',
            fontFamily: 'inherit',
          }}
        />
        <div style={{ fontSize: 11, color: 'var(--color-ink-4)', textAlign: 'right', marginTop: 2 }}>
          {m.settings_chars_remaining({ remaining })}
        </div>
      </div>
    </div>
  )
}
