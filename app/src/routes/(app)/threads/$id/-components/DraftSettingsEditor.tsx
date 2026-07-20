import { useCallback, useEffect, useRef, useState } from 'react'
import { AutoSaveBadge, type AutoSaveState } from '~/routes/(app)/-components/AutoSaveBadge'
import { CUSTOMER_PROMPT_MAX } from '~/lib/settings/char-limits'
import { updateConversationSettingsFn } from '../-lib/update-conversation-settings.fn'
import { m } from '~/paraglide/messages'

type TonePreset = 'friendly' | 'professional' | 'concise' | null

interface DraftSettingsEditorProps {
  conversationId: string
  /** Initial value only — read at mount. Remount with key={conversationId} to reset. */
  tonePreset: TonePreset
  /** Initial value only — read at mount. Remount with key={conversationId} to reset. */
  customPrompt: string | null
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
}: DraftSettingsEditorProps) {
  // Local state is the sole source of truth after mount — server values must
  // never overwrite it while the user is viewing this conversation (#72).
  const [tone, setTone] = useState<TonePreset>(initialTone)
  const [toneSaveState, setToneSaveState] = useState<AutoSaveState>(null)
  const [prompt, setPrompt] = useState(initialPrompt ?? '')
  const [promptSaveState, setPromptSaveState] = useState<AutoSaveState>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  // Latest values for the error-badge retry buttons (#84).
  const promptRef = useRef(prompt)
  const lastToneRef = useRef<TonePreset>(initialTone)

  // Cancel pending debounce on unmount; an already in-flight save still
  // completes server-side, but must not set state afterwards (key remount).
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  // #84: tone save failures must surface — the operator otherwise keeps seeing
  // the selected chip while the AI drafts with the old tone.
  const saveTone = useCallback(async (value: TonePreset) => {
    lastToneRef.current = value
    setToneSaveState('saving')
    try {
      await updateConversationSettingsFn({ data: { conversationId, tonePreset: value } })
      if (!mountedRef.current || lastToneRef.current !== value) return
      setToneSaveState('saved')
    } catch {
      if (!mountedRef.current || lastToneRef.current !== value) return
      setToneSaveState('error')
    }
  }, [conversationId])

  const handleToneClick = useCallback((value: TonePreset) => {
    const next = tone === value ? null : value
    setTone(next)
    void saveTone(next)
  }, [tone, saveTone])

  const savePrompt = useCallback(async () => {
    setPromptSaveState('saving')
    try {
      await updateConversationSettingsFn({ data: { conversationId, customPrompt: promptRef.current } })
      if (!mountedRef.current) return
      setPromptSaveState('saved')
    } catch {
      if (!mountedRef.current) return
      setPromptSaveState('error')
    }
  }, [conversationId])

  const handlePromptChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setPrompt(value)
    promptRef.current = value
    setPromptSaveState('editing')
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void savePrompt()
    }, DEBOUNCE_MS)
  }, [savePrompt])

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
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 6,
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--color-ink-2)' }}>
            {m.cp_tone_label()}
          </div>
          <AutoSaveBadge
            state={toneSaveState}
            onRetry={() => void saveTone(lastToneRef.current)}
          />
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
          <AutoSaveBadge state={promptSaveState} onRetry={() => void savePrompt()} />
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
