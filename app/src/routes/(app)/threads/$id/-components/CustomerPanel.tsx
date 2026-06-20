import { useCallback, useEffect, useState } from 'react'
import type { ConversationDetail } from '../-lib/get-conversation.fn'
import { CustomerPanelHeader } from './CustomerPanelHeader'
import { AiPersonaSummary } from './AiPersonaSummary'
import { DraftSettingsEditor } from './DraftSettingsEditor'
import { InternalNoteEditor } from './InternalNoteEditor'
import { XIcon } from '~/components/ui/icons'
import { m } from '~/paraglide/messages'

type ConversationSettings = Pick<
  ConversationDetail['conversation'],
  'tone_preset' | 'custom_prompt' | 'note' | 'summary' | 'last_summarized_at'
>

interface CustomerPanelProps {
  conversation: ConversationDetail['conversation']
  isOpen: boolean
  onClose: () => void
}

const STORAGE_KEY = 'customer-panel-open'
// Below this width the panel renders as a full-height overlay (see styles.css),
// so it must default to closed — otherwise it covers the whole thread on mobile.
const DESKTOP_QUERY = '(min-width: 1280px)'

function readStoredOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

function writeStoredOpen(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false')
  } catch {
    // ignore storage errors
  }
}

export function useCustomerPanelOpen() {
  // Start closed so the SSR/first paint never covers the thread on mobile.
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    // Only restore the docked-open preference on desktop; on narrow screens the
    // panel is an on-demand overlay and stays closed until the user opens it.
    const isDesktop =
      typeof window !== 'undefined' && window.matchMedia(DESKTOP_QUERY).matches
    setIsOpen(isDesktop ? readStoredOpen() : false)
  }, [])

  const toggle = useCallback(() => {
    setIsOpen((prev) => {
      const next = !prev
      writeStoredOpen(next)
      return next
    })
  }, [])

  return { isOpen, toggle }
}

export function CustomerPanel({ conversation, isOpen, onClose }: CustomerPanelProps) {
  const [settings, setSettings] = useState<ConversationSettings>({
    tone_preset: conversation.tone_preset,
    custom_prompt: conversation.custom_prompt,
    note: conversation.note,
    summary: conversation.summary,
    last_summarized_at: conversation.last_summarized_at,
  })

  // Sync when conversation changes (e.g. router invalidation)
  useEffect(() => {
    setSettings({
      tone_preset: conversation.tone_preset,
      custom_prompt: conversation.custom_prompt,
      note: conversation.note,
      summary: conversation.summary,
      last_summarized_at: conversation.last_summarized_at,
    })
  }, [conversation])

  const handleDraftUpdate = useCallback(
    (fields: { tonePreset?: typeof settings.tone_preset; customPrompt?: string | null }) => {
      setSettings((prev) => ({
        ...prev,
        ...(fields.tonePreset !== undefined ? { tone_preset: fields.tonePreset } : {}),
        ...(fields.customPrompt !== undefined ? { custom_prompt: fields.customPrompt } : {}),
      }))
    },
    [],
  )

  const handleNoteUpdate = useCallback((note: string | null) => {
    setSettings((prev) => ({ ...prev, note }))
  }, [])

  return (
    <div
      className={`customer-panel${isOpen ? ' customer-panel--open' : ' customer-panel--hidden'}`}
      aria-hidden={!isOpen}
    >
      <div
        style={{
          height: '100%',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Mobile-only close bar — on narrow screens the panel is a full-height
            overlay covering the thread header's toggle, so it needs its own close. */}
        <button
          type="button"
          className="customer-panel__close"
          onClick={onClose}
          aria-label={m.cp_toggle_hide()}
          style={{
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 6,
            padding: '10px 14px',
            borderBottom: '1px solid var(--color-line)',
            background: 'var(--color-bg-raised)',
            color: 'var(--color-ink-2)',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            width: '100%',
          }}
        >
          <XIcon size={15} />
          <span>{m.cp_toggle_hide()}</span>
        </button>
        <CustomerPanelHeader
          conversationId={conversation.id}
          customerName={conversation.customer_name}
          customerPsid={conversation.customer_psid}
        />
        <div style={{ borderBottom: '1px solid var(--color-line)' }}>
          <AiPersonaSummary
            summary={settings.summary}
            lastSummarizedAt={settings.last_summarized_at}
          />
        </div>
        <div style={{ borderBottom: '1px solid var(--color-line)' }}>
          <DraftSettingsEditor
            conversationId={conversation.id}
            tonePreset={settings.tone_preset}
            customPrompt={settings.custom_prompt}
            onUpdate={handleDraftUpdate}
          />
        </div>
        <InternalNoteEditor
          conversationId={conversation.id}
          note={settings.note}
          onUpdate={handleNoteUpdate}
        />
      </div>
    </div>
  )
}
