import { useCallback, useRef, useState } from 'react'
import { AutoSaveBadge } from '~/routes/(app)/-components/AutoSaveBadge'
import { useAutoSave } from '~/routes/(app)/-components/useAutoSave'
import { NOTE_MAX } from '~/lib/settings/char-limits'
import { updateConversationSettingsFn } from '../-lib/update-conversation-settings.fn'
import { m } from '~/paraglide/messages'

interface InternalNoteEditorProps {
  conversationId: string
  /** Initial value only — read at mount. Remount with key={conversationId} to reset. */
  note: string | null
}

export function InternalNoteEditor({ conversationId, note: initialNote }: InternalNoteEditorProps) {
  // Local state is the sole source of truth after mount — server values must
  // never overwrite it while the user is viewing this conversation (#72).
  const [note, setNote] = useState(initialNote ?? '')
  // Latest value for the debounced save / error-badge retry (#84).
  const noteRef = useRef(note)

  const { state: saveState, schedule, flush } = useAutoSave({
    save: () => updateConversationSettingsFn({ data: { conversationId, note: noteRef.current } }),
  })

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setNote(value)
    noteRef.current = value
    schedule()
  }, [schedule])

  const remaining = NOTE_MAX - note.length

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
        {m.cp_section_note()}
      </div>
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
            {m.cp_note_label()}
          </label>
          <AutoSaveBadge state={saveState} onRetry={flush} />
        </div>
        <textarea
          value={note}
          onChange={handleChange}
          maxLength={NOTE_MAX}
          placeholder={m.cp_note_placeholder()}
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
