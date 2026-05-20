import { useCallback, useEffect, useState } from 'react'
import type { ConversationDetail } from '../-lib/get-conversation.fn'
import { CustomerPanelHeader } from './CustomerPanelHeader'
import { AiPersonaSummary } from './AiPersonaSummary'
import { DraftSettingsEditor } from './DraftSettingsEditor'
import { InternalNoteEditor } from './InternalNoteEditor'

type ConversationSettings = Pick<
  ConversationDetail['conversation'],
  'tone_preset' | 'custom_prompt' | 'note' | 'summary' | 'last_summarized_at'
>

interface CustomerPanelProps {
  conversation: ConversationDetail['conversation']
  isOpen: boolean
}

const STORAGE_KEY = 'customer-panel-open'

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
  const [isOpen, setIsOpen] = useState(true)

  useEffect(() => {
    setIsOpen(readStoredOpen())
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

export function CustomerPanel({ conversation, isOpen }: CustomerPanelProps) {
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
      className={`customer-panel${isOpen ? '' : ' customer-panel--hidden'}`}
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
        <CustomerPanelHeader
          customerId={conversation.id}
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
